from __future__ import annotations

import base64
import json
import re
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Any

import httpx

from .db import execute, fetch_all, fetch_one
from .settings import settings


def next_inventory_id(location_code: str = "SIM") -> str:
    year = date.today().year
    prefix = f"SHR-{location_code}-{year}-"
    row = fetch_one(
        """
        SELECT COALESCE(max(substring(inventory_id from %s)::int), 0)::int AS max_number
        FROM inventory_items
        WHERE inventory_id LIKE %s
        """,
        (len(prefix) + 1, prefix + "%"),
    )
    return f"{prefix}{(row or {'max_number': 0})['max_number'] + 1:06d}"


def audit(action: str, entity_type: str, entity_id: str | None, new_value: Any = None, reason: str | None = None):
    execute(
        """
        INSERT INTO audit_log (tenant_id, entity_type, entity_id, action, new_value_json, reason)
        VALUES ((SELECT id FROM tenants WHERE slug = %s LIMIT 1), %s, %s, %s, %s::jsonb, %s)
        RETURNING id
        """,
        (settings.default_tenant_slug, entity_type, entity_id, action, json_dumps(new_value), reason),
    )


def json_dumps(value: Any) -> str:
    import json

    return json.dumps(value or {}, default=str)


def classify_it_peripheral(text: str, object_type: str | None = None) -> tuple[str, dict[str, Any]] | None:
    haystack = f"{text} {object_type or ''}".lower()
    if any(term in haystack for term in ["nespresso", "kaffeemaschine", "kapselmaschine", "espresso"]):
        return (
            "kuechengeraet",
            {
                "object_type": "Kaffeemaschine",
                "object_class": "Kaffeemaschine",
                "commercial_category": "betriebsmittel",
                "requires_accounting_review": False,
                "missing_fields": [],
                "recommended_tasks": [],
                "recommended_status": "pruefen",
                "confidence": 0.78,
            },
        )
    if any(term in haystack for term in ["computermaus", "maus", "mouse", "hyperx", "logitech", "razer"]):
        return (
            "eingabegeraet",
            {
                "object_type": "Computermaus",
                "object_class": "Computermaus",
                "commercial_category": "it_ausstattung",
                "requires_accounting_review": False,
                "missing_fields": [],
                "recommended_tasks": [],
                "recommended_status": "pruefen",
                "confidence": 0.78,
            },
        )
    if any(term in haystack for term in ["tastatur", "keyboard", "keychron", "cherry", "logitech mx keys"]):
        return (
            "eingabegeraet",
            {
                "object_type": "Tastatur",
                "object_class": "Tastatur",
                "commercial_category": "it_ausstattung",
                "requires_accounting_review": False,
                "missing_fields": [],
                "recommended_tasks": [],
                "recommended_status": "pruefen",
                "confidence": 0.78,
            },
        )
    if any(term in haystack for term in ["laptop", "notebook", "elitebook", "thinkpad", "probook", "macbook"]):
        return (
            "notebook",
            {
                "object_type": "Notebook",
                "object_class": "Laptop/PC",
                "commercial_category": "it_ausstattung",
                "requires_accounting_review": True,
                "missing_fields": ["Seriennummer", "Anschaffungsdatum", "Buchwert"],
                "recommended_tasks": [{"role": "Auswertung", "task": "Wert und Zuordnung später klären"}],
                "recommended_status": "nacharbeit_buchhaltung",
                "confidence": 0.76,
            },
        )
    return None


WORKSHOP_REFERENCE_CATALOG: list[dict[str, Any]] = [
    {
        "object_class": "Wuchtmaschine",
        "slug": "wuchtmaschine",
        "visual_features": ["Radaufnahme/Spindel", "Bedienpanel oder Display", "Schutzhaube", "Gehäuse mit seitlicher Ablage"],
        "typical_brands": ["Hofmann", "Hunter", "Corghi", "Sicam", "Beissbarth", "John Bean"],
        "required_hints": ["Objektfoto", "Typenschildfoto wenn erreichbar", "Hersteller", "Modell", "Seriennummer"],
        "commercial_category": "werkstattausstattung",
        "requires_accounting_review": True,
    },
    {
        "object_class": "Reifenmontiermaschine",
        "slug": "reifenmontiermaschine",
        "visual_features": ["Montageteller", "Montagearm", "Abdrückschaufel", "Pedale", "Spannbacken"],
        "typical_brands": ["Hofmann", "Corghi", "Sicam", "Butler", "Ravaglioli", "Hunter"],
        "required_hints": ["Objektfoto", "Typenschildfoto wenn erreichbar", "Hersteller", "Modell", "Seriennummer"],
        "commercial_category": "werkstattausstattung",
        "requires_accounting_review": True,
    },
    {
        "object_class": "Hebebühne",
        "slug": "hebebuehne",
        "visual_features": ["Säulen oder Scherenhub", "Tragarme oder Plattform", "Bedieneinheit", "Traglastschild", "Werkstattplatz"],
        "typical_brands": ["Nussbaum", "Ravaglioli", "Rotary", "Consul", "MAHA", "ATH Heinl"],
        "required_hints": ["Objektfoto", "Typenschildfoto", "Seriennummer", "Tragfähigkeit"],
        "commercial_category": "anlagevermoegen",
        "requires_accounting_review": True,
    },
    {
        "object_class": "Diagnosegerät",
        "slug": "diagnosegeraet",
        "visual_features": ["Tablet oder Handgerät", "OBD-Kabel", "Dockingstation", "Werkstattwagen oder Koffer"],
        "typical_brands": ["Bosch", "Gutmann", "Hella Gutmann", "Texa", "Launch", "Autel"],
        "required_hints": ["Objektfoto", "Hersteller", "Modell", "Seriennummer falls sichtbar"],
        "commercial_category": "gwg_pruefen",
        "requires_accounting_review": True,
    },
    {
        "object_class": "Kompressor",
        "slug": "kompressor",
        "visual_features": ["Druckkessel", "Motorblock", "Manometer", "Druckluftanschlüsse", "Typenschild"],
        "typical_brands": ["Kaeser", "CompAir", "Atlas Copco", "Aircraft", "Schneider", "Boge"],
        "required_hints": ["Objektfoto", "Typenschildfoto wenn erreichbar", "Hersteller", "Modell", "Seriennummer"],
        "commercial_category": "werkstattausstattung",
        "requires_accounting_review": True,
    },
]

BGA_OBJECT_CLASSES = [
    "IT-Zubehör",
    "Computermaus",
    "Tastatur",
    "Monitor",
    "Drucker",
    "Scanner",
    "Laptop/PC",
    "Telefon",
    "Büroausstattung",
    "Schreibtisch",
    "Bürostuhl",
    "Schrank",
    "Regal",
    "Werkstattmöbel",
    "Werkbank",
    "Werkzeugwagen",
    "Spezialgerät",
    "Diagnosegerät",
    "Ladegerät",
    "Kaffeemaschine",
    "Maschine",
    "Hebebühne",
    "Kompressor",
    "Reinigungsgerät",
    "Sonstiges",
    "Unklar",
]

BGA_OBJECT_CANDIDATES: list[dict[str, Any]] = [
    {
        "object_name": "Computermaus",
        "object_class": "Computermaus",
        "visual_features": ["handgroßes Zeigegerät", "linke/rechte Taste", "Scrollrad", "Kabel oder USB-/Funkempfänger"],
        "category": "it_ausstattung",
    },
    {
        "object_name": "Tastatur",
        "object_class": "Tastatur",
        "visual_features": ["viele Tasten in Reihen", "Ziffernblock oder Funktionsleiste", "Kabel oder Funk"],
        "category": "it_ausstattung",
    },
    {
        "object_name": "Monitor",
        "object_class": "Monitor",
        "visual_features": ["einzelner Bildschirm", "Displayfläche", "Standfuß", "keine fest verbundene Tastatur"],
        "category": "it_ausstattung",
    },
    {
        "object_name": "Notebook",
        "object_class": "Laptop/PC",
        "visual_features": ["aufklappbares Gerät", "Bildschirm und Tastatur in einem Gerät", "Touchpad"],
        "category": "it_ausstattung",
    },
    {"object_name": "Drucker", "object_class": "Drucker", "visual_features": ["Papierfach", "Ausgabeschacht", "Bedienpanel"], "category": "it_ausstattung"},
    {"object_name": "Scanner", "object_class": "Scanner", "visual_features": ["Flachbett", "Einzug", "Scanfläche"], "category": "it_ausstattung"},
    {"object_name": "Telefon", "object_class": "Telefon", "visual_features": ["Hörer", "Tastenfeld", "Display", "Telefonkabel oder DECT-Basis"], "category": "it_ausstattung"},
    {"object_name": "Kaffeemaschine", "object_class": "Kaffeemaschine", "visual_features": ["Kapselmaschine", "Wassertank", "Tassenablage", "Nespresso- oder Espresso-Geraet"], "category": "betriebsmittel"},
    {"object_name": "Werkzeugwagen", "object_class": "Werkzeugwagen", "visual_features": ["rollbarer Schubladenschrank", "Werkzeugschubladen"], "category": "werkstattausstattung"},
    {"object_name": "Schreibtisch", "object_class": "Schreibtisch", "visual_features": ["Arbeitsplatte", "Tischbeine", "Büroarbeitsplatz"], "category": "bueroausstattung"},
    {"object_name": "Bürostuhl", "object_class": "Bürostuhl", "visual_features": ["Sitzfläche", "Rückenlehne", "Rollen", "Armlehnen"], "category": "bueroausstattung"},
    {"object_name": "Schrank", "object_class": "Schrank", "visual_features": ["Türen", "Fächer", "Büro- oder Lagerschrank"], "category": "betriebsmittel"},
    {"object_name": "Regal", "object_class": "Regal", "visual_features": ["mehrere Ablageebenen", "Lager- oder Büroregal"], "category": "betriebsmittel"},
    {"object_name": "Werkbank", "object_class": "Werkbank", "visual_features": ["massive Arbeitsplatte", "Werkstattarbeitsplatz"], "category": "werkstattausstattung"},
    {"object_name": "Hebebühne", "object_class": "Hebebühne", "visual_features": ["Säulen oder Scherenhub", "Tragarme oder Plattform"], "category": "anlagevermoegen"},
    {"object_name": "Kompressor", "object_class": "Kompressor", "visual_features": ["Druckkessel", "Motorblock", "Manometer"], "category": "werkstattausstattung"},
    {"object_name": "Ladegerät", "object_class": "Ladegerät", "visual_features": ["Netzteil", "Ladestation", "Kabelanschlüsse"], "category": "betriebsmittel"},
    {"object_name": "Diagnosegerät", "object_class": "Diagnosegerät", "visual_features": ["Handgerät oder Tablet", "OBD-Kabel", "Dockingstation"], "category": "werkstattausstattung"},
    {"object_name": "Spezialgerät", "object_class": "Spezialgerät", "visual_features": ["Spezialwerkzeug", "Prüfgerät", "Koffer oder Adapter"], "category": "betriebsmittel"},
    {"object_name": "Werkstattmöbel", "object_class": "Werkstattmöbel", "visual_features": ["Werkstattschrank", "Arbeitsmöbel", "Ablage in Werkstatt"], "category": "werkstattausstattung"},
    {"object_name": "Reinigungsgerät", "object_class": "Reinigungsgerät", "visual_features": ["Sauger", "Reinigungsmaschine", "Schlauch oder Tank"], "category": "betriebsmittel"},
    {"object_name": "Maschine", "object_class": "Maschine", "visual_features": ["stationäres Gerät", "Bedienfeld", "Typenschild"], "category": "werkstattausstattung"},
    {"object_name": "Sonstige Ausstattung", "object_class": "Sonstiges", "visual_features": ["nicht eindeutig zuordenbar"], "category": "ungeklaert"},
    {"object_name": "Unklares Objekt", "object_class": "Unklar", "visual_features": ["nicht sicher erkennbar"], "category": "ungeklaert"},
]

BGA_PROMPT_TEST_CASES: list[dict[str, Any]] = [
    {"case": "Computermaus", "expected_class": "Computermaus", "expected_object_name": "Computermaus", "guard": "nicht Monitor/Tastatur/Laptop"},
    {"case": "Nespresso Kapselmaschine", "expected_class": "Kaffeemaschine", "expected_object_name": "Kaffeemaschine", "guard": "nicht Sonstiges und kein automatischer Wert"},
    {"case": "Tastatur", "expected_class": "Tastatur", "expected_object_name": "Tastatur", "guard": "nicht Monitor"},
    {"case": "Monitor", "expected_class": "Monitor", "expected_object_name": "Monitor", "guard": "nur einzelner Bildschirm ohne Tastatur-Unterteil"},
    {"case": "Bürostuhl", "expected_class": "Bürostuhl", "expected_object_name": "Bürostuhl", "guard": "Rollen/Rückenlehne/Sitzfläche"},
    {"case": "Werkzeugwagen", "expected_class": "Werkzeugwagen", "expected_object_name": "Werkzeugwagen", "guard": "rollbarer Schubladenschrank"},
    {"case": "Unbekanntes Gerät", "expected_class": "Unklar", "expected_object_name": "vermutlich ...", "guard": "confidence niedrig und requires_manual_review=true"},
]


def normalize_bga_object_class(value: Any, object_name: Any = None) -> str:
    raw = str(value or "").strip()
    text = f"{raw} {object_name or ''}".lower()
    text = (
        text.replace("ä", "ae")
        .replace("ö", "oe")
        .replace("ü", "ue")
        .replace("ß", "ss")
        .replace("-", " ")
        .replace("/", " ")
    )
    if any(term in text for term in ["computermaus", "maus", "mouse"]):
        return "Computermaus"
    if any(term in text for term in ["tastatur", "keyboard"]):
        return "Tastatur"
    if any(term in text for term in ["nespresso", "kaffeemaschine", "kapselmaschine", "espresso"]):
        return "Kaffeemaschine"
    if raw in BGA_OBJECT_CLASSES:
        return raw
    if "monitor" in text or "bildschirm" in text:
        return "Monitor"
    if any(term in text for term in ["laptop", "notebook", "pc", "computer", "thinkpad", "elitebook", "probook", "macbook"]):
        return "Laptop/PC"
    if "drucker" in text:
        return "Drucker"
    if "scanner" in text:
        return "Scanner"
    if "telefon" in text or "dect" in text or "smartphone" in text or "iphone" in text:
        return "Telefon"
    if "schreibtisch" in text:
        return "Schreibtisch"
    if "buerostuhl" in text or "stuhl" in text:
        return "Bürostuhl"
    if "schrank" in text:
        return "Schrank"
    if "regal" in text:
        return "Regal"
    if "werkbank" in text:
        return "Werkbank"
    if "werkzeugwagen" in text:
        return "Werkzeugwagen"
    if "diagnose" in text or "tester" in text:
        return "Diagnosegerät"
    if "ladegeraet" in text or "ladegerät" in raw.lower():
        return "Ladegerät"
    if "hebebuehne" in text or "hebebühne" in raw.lower():
        return "Hebebühne"
    if "kompressor" in text:
        return "Kompressor"
    if "reinigung" in text or "sauger" in text:
        return "Reinigungsgerät"
    if "werkstattmoebel" in text or "werkstattmöbel" in raw.lower():
        return "Werkstattmöbel"
    if "spezial" in text or "pruefgeraet" in text or "prüfgerät" in raw.lower():
        return "Spezialgerät"
    if "maschine" in text:
        return "Maschine"
    if "buero" in text or "büro" in raw.lower():
        return "Büroausstattung"
    if "it" in text or "eingabegeraet" in text or "eingabegerät" in raw.lower():
        return "IT-Zubehör"
    if "sonstig" in text:
        return "Sonstiges"
    return "Unklar"


def bga_candidate_for_class(object_class: str | None) -> dict[str, Any] | None:
    for candidate in BGA_OBJECT_CANDIDATES:
        if candidate.get("object_class") == object_class:
            return candidate
    return None


def clamp_confidence(value: Any, default: float = 0.6) -> float:
    try:
        confidence = float(value)
    except (TypeError, ValueError):
        return default
    if confidence > 1:
        confidence = confidence / 100
    return max(0.0, min(1.0, confidence))


def first_text(*values: Any) -> str | None:
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return None


def bga_review_missing_fields(object_class: str, fallback: dict[str, Any]) -> list[str]:
    simple_classes = {
        "Computermaus",
        "Tastatur",
        "Monitor",
        "Drucker",
        "Scanner",
        "Telefon",
        "Kaffeemaschine",
        "Büroausstattung",
        "Schreibtisch",
        "Bürostuhl",
        "Schrank",
        "Regal",
        "Ladegerät",
    }
    machine_classes = {"Maschine", "Hebebühne", "Kompressor", "Werkzeugwagen", "Werkbank", "Diagnosegerät", "Spezialgerät"}
    if object_class in simple_classes:
        return []
    if object_class in machine_classes:
        return ["Typenschild/Seriennummer prüfen"]
    if object_class == "Unklar":
        return ["Bezeichnung prüfen"]
    return list(fallback.get("missing_fields") or [])


def plausible_value_limit(object_class: str) -> int | None:
    return {
        "Computermaus": 100,
        "Tastatur": 250,
        "Monitor": 600,
        "Drucker": 800,
        "Scanner": 600,
        "Telefon": 300,
        "Ladegerät": 250,
        "Kaffeemaschine": 80,
        "Bürostuhl": 800,
        "Schreibtisch": 800,
        "Regal": 800,
    }.get(object_class)


def normalize_estimates(result: dict[str, Any], object_class: str, confidence: float) -> None:
    estimated_value = result.get("estimated_value_eur")
    if estimated_value is None:
        estimated_value = result.get("estimated_value")
    try:
        estimated_value_number = float(estimated_value) if estimated_value is not None else None
    except (TypeError, ValueError):
        estimated_value_number = None

    value_confidence = clamp_confidence(result.get("estimated_value_confidence"), 0.0)
    value_reason = first_text(result.get("estimated_value_reason"), result.get("value_reason"))
    value_source = str(result.get("value_source") or "").lower().strip()
    credible_value_source = value_source in {"webrecherche", "gebrauchtmarkt", "beleg", "referenzpreis", "gepruefte_referenz"}
    value_limit = plausible_value_limit(object_class)
    value_rejected_reason = None
    if estimated_value_number is not None and value_limit is not None and estimated_value_number > value_limit:
        value_rejected_reason = f"KI-Wert {estimated_value_number:g} EUR ist für {object_class} unplausibel und wurde nicht übernommen."
    elif estimated_value_number is not None and (confidence < 0.86 or value_confidence < 0.7 or not value_reason or not credible_value_source):
        value_rejected_reason = "Keine belastbare Quelle für einen Wertvorschlag erkannt."
    elif object_class in {"Unklar", "Sonstiges"}:
        value_rejected_reason = "Objektklasse unklar, Wert wird nicht geschätzt."

    if estimated_value_number is None or value_rejected_reason:
        result["estimated_value_eur"] = None
        result["estimated_value"] = None
        result["estimated_value_confidence"] = 0.0
        result["estimated_value_reason"] = value_rejected_reason or value_reason or "Kein belastbarer Wertvorschlag."
        result["value_requires_review"] = True
    else:
        result["estimated_value_eur"] = round(estimated_value_number, 2)
        result["estimated_value"] = round(estimated_value_number, 2)
        result["estimated_value_confidence"] = value_confidence
        result["estimated_value_reason"] = value_reason
        result["value_requires_review"] = True

    try:
        estimated_age = float(result.get("estimated_age_years")) if result.get("estimated_age_years") is not None else None
    except (TypeError, ValueError):
        estimated_age = None
    age_confidence = clamp_confidence(result.get("age_confidence"), 0.0)
    age_reason = first_text(result.get("age_reason"), result.get("age_source"))
    age_source = str(result.get("age_source") or "").lower().strip()
    age_status = str(result.get("age_verification_status") or "").lower().strip()
    credible_age_sources = {"typenschild", "baujahr", "modelljahr", "sichtbare_angabe", "seriennummer", "beleg", "dot"}
    if (
        estimated_age is None
        or age_source not in credible_age_sources
        or age_status in {"geschaetzt", "nicht_ermittelbar", "offen", ""}
        or age_confidence < 0.7
        or not age_reason
    ):
        result["estimated_age_years"] = None
        result["age_source"] = "unbekannt"
        result["age_verification_status"] = "offen"
        result["age_confidence"] = 0.0
        result["age_reason"] = age_reason or "Kein Baujahr oder Typenschild als belastbare Altersgrundlage erkannt."
        result["age_requires_review"] = True
    else:
        result["estimated_age_years"] = round(estimated_age, 1)
        result["age_confidence"] = age_confidence
        result["age_requires_review"] = True


@lru_cache(maxsize=1)
def load_special_tool_references() -> list[dict[str, Any]]:
    path = Path(__file__).parent / "knowledge" / "special_tools_reference.json"
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig") as handle:
        payload = json.load(handle)
    records = payload.get("records", [])
    return records if isinstance(records, list) else []


@lru_cache(maxsize=1)
def load_inventory_history_references() -> list[dict[str, Any]]:
    path = Path(__file__).parent / "knowledge" / "inventory_history_reference.json"
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig") as handle:
        payload = json.load(handle)
    records = payload.get("records", [])
    return records if isinstance(records, list) else []


def tokenize_reference_text(value: str) -> set[str]:
    stopwords = {"vas", "vag", "ase", "und", "oder", "and", "or", "mit", "für", "the", "set"}
    tokens = re.findall(r"[a-zA-ZÄÖÜäöüß0-9/.-]{3,}", value.lower())
    return {token.strip(".-/") for token in tokens if token.strip(".-/") and token.strip(".-/") not in stopwords}


def select_special_tool_references(transcripts: list[str], object_class_name: str | None, limit: int = 25) -> list[dict[str, Any]]:
    query = " ".join([object_class_name or "", *transcripts]).lower()
    query_tokens = tokenize_reference_text(query)
    if not query_tokens:
        query_tokens = tokenize_reference_text(object_class_name or "")
    scored: list[tuple[int, dict[str, Any]]] = []
    for record in load_special_tool_references():
        has_designation = bool(record.get("designation_de") or record.get("designation_en"))
        order_no = str(record.get("order_no") or "")
        vag_no = str(record.get("vag_no") or "")
        has_identifier = bool(order_no and len(order_no) > 2 and len(order_no) <= 40 and re.search(r"\d", order_no)) or bool(
            vag_no and len(vag_no) <= 40 and re.search(r"\d", vag_no)
        )
        if not has_designation and not has_identifier:
            continue
        haystack = " ".join(
            str(record.get(key) or "")
            for key in ["designation_de", "designation_en", "order_no", "vag_no", "category_hint"]
        )
        record_tokens = tokenize_reference_text(haystack)
        score = len(query_tokens & record_tokens)
        if vag_no and len(vag_no) <= 40 and re.search(r"\d", vag_no) and vag_no.lower() in query:
            score += 8
        if order_no and len(order_no) <= 40 and re.search(r"\d", order_no) and order_no.lower() in query:
            score += 8
        if score > 0:
            scored.append((score, record))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [
        {
            "designation_de": record.get("designation_de"),
            "designation_en": record.get("designation_en"),
            "order_no": record.get("order_no"),
            "vag_no": record.get("vag_no"),
            "category_hint": record.get("category_hint"),
            "source_file": record.get("source_file"),
        }
        for _, record in scored[:limit]
    ]


def select_inventory_history_references(transcripts: list[str], object_class_name: str | None, limit: int = 15) -> list[dict[str, Any]]:
    query = " ".join([object_class_name or "", *transcripts]).lower()
    query_tokens = tokenize_reference_text(query)
    scored: list[tuple[int, dict[str, Any]]] = []
    for record in load_inventory_history_references():
        tool_no = str(record.get("tool_no") or "")
        haystack = " ".join(
            str(record.get(key) or "")
            for key in ["designation_de", "tool_no", "action", "note", "list_name", "record_type"]
        )
        record_tokens = tokenize_reference_text(haystack)
        score = len(query_tokens & record_tokens)
        if tool_no and len(tool_no) <= 40 and tool_no.lower() in query:
            score += 10
        if score > 0:
            scored.append((score, record))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [
        {
            "record_type": record.get("record_type"),
            "designation_de": record.get("designation_de"),
            "tool_no": record.get("tool_no"),
            "action": record.get("action"),
            "note": record.get("note"),
            "missing": record.get("missing"),
            "defective": record.get("defective"),
            "uvv_due": record.get("uvv_due"),
            "maintenance_due": record.get("maintenance_due"),
            "inspection_book_missing": record.get("inspection_book_missing"),
            "source_file": record.get("source_file"),
        }
        for _, record in scored[:limit]
    ]


def select_learning_examples(
    transcripts: list[str],
    object_class_name: str | None,
    object_type: str | None,
    limit: int = 8,
) -> list[dict[str, Any]]:
    query = " ".join([object_class_name or "", object_type or "", *transcripts]).lower()
    query_tokens = tokenize_reference_text(query)
    rows = fetch_all(
        """
        SELECT id, object_class_name, object_type, brand, model, serial_number, condition,
               corrected_json, notes, created_at
        FROM ai_learning_examples
        WHERE approved = true
        ORDER BY created_at DESC
        LIMIT 200
        """
    )
    scored: list[tuple[int, dict[str, Any]]] = []
    for row in rows:
        corrected = row.get("corrected_json") or {}
        haystack = " ".join(
            str(row.get(key) or "")
            for key in ["object_class_name", "object_type", "brand", "model", "serial_number", "notes"]
        ) + " " + " ".join(str(corrected.get(key) or "") for key in ["specification", "construction_year", "value_estimate", "estimated_age_years"])
        score = len(query_tokens & tokenize_reference_text(haystack))
        if object_class_name and str(row.get("object_class_name") or "").lower() == object_class_name.lower():
            score += 5
        if object_type and str(row.get("object_type") or "").lower() == object_type.lower():
            score += 4
        if score > 0:
            scored.append((score, row))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [
        {
            "object_class": row.get("object_class_name"),
            "object_type": row.get("object_type"),
            "brand": row.get("brand"),
            "model": row.get("model"),
            "serial_number_present": bool(row.get("serial_number")),
            "condition": row.get("condition"),
            "corrected_fields": row.get("corrected_json") or {},
            "specification": (row.get("corrected_json") or {}).get("specification"),
            "construction_year": (row.get("corrected_json") or {}).get("construction_year"),
            "value_estimate": (row.get("corrected_json") or {}).get("value_estimate"),
            "estimated_age_years": (row.get("corrected_json") or {}).get("estimated_age_years"),
            "notes": row.get("notes"),
        }
        for _, row in scored[:limit]
    ]


def build_ai_suggestion(item_id: str, mode: str = "fast") -> dict[str, Any]:
    fallback = build_stub_suggestion(item_id)
    try:
        return build_ollama_suggestion(item_id, fallback, mode)
    except Exception as exc:
        fallback["notes"] = f"{fallback.get('notes')} Ollama-Auswertung fehlgeschlagen, Stub genutzt: {type(exc).__name__}: {str(exc)[:180]}"
        fallback["_model_used"] = "phase1-stub"
        return fallback


def build_stub_suggestion(item_id: str) -> dict[str, Any]:
    item = fetch_one(
        """
        SELECT i.*, oc.slug AS object_class_slug, oc.name AS object_class_name
        FROM inventory_items i
        LEFT JOIN object_classes oc ON oc.id = i.object_class_id
        WHERE i.id = %s
        """,
        (item_id,),
    )
    notes = fetch_all("SELECT transcript FROM item_audio_notes WHERE item_id = %s", (item_id,))
    transcripts = [str(n.get("transcript") or "") for n in notes if n.get("transcript")]
    text = " ".join(transcripts).lower()
    object_type = (item or {}).get("object_type") or "Unbekanntes Objekt"
    object_class = (item or {}).get("object_class_slug") or "monitor"
    object_class_name = (item or {}).get("object_class_name") or "Monitor"
    result: dict[str, Any] = {
        "object_type": object_type,
        "object_class": object_class_name,
        "category": None,
        "brand": None,
        "model": None,
        "serial_number": None,
        "condition": (item or {}).get("condition") or "gebraucht",
        "condition_note": None,
        "location_hint": None,
        "detected_inventory_id": (item or {}).get("inventory_id"),
        "manufacturing_date": None,
        "acquisition_date": None,
        "commissioning_date": None,
        "estimated_age_years": None,
        "age_source": "buchhaltung",
        "age_verification_status": "offen",
        "commercial_category": "it_ausstattung",
        "requires_accounting_review": True,
        "missing_fields": ["Seriennummer", "Anschaffungsdatum", "Buchwert"],
        "required_evidence_missing": [],
        "recommended_tasks": [{"role": "Auswertung", "task": "Wert und Zuordnung später klären"}],
        "confidence": 0.62,
        "requires_review": True,
        "recommended_status": "nacharbeit_buchhaltung",
        "notes": "Phase-1-Auswertung. Ollama/Vision läuft im Hintergrund.",
    }

    quick_it = classify_it_peripheral(text, object_type)
    if quick_it:
        object_class, update = quick_it
        result.update(update)
    elif object_class == "reifen" or "reifen" in text or "dot" in text or "michelin" in text:
        dot = re.search(r"\b(\d{4})\b", text)
        dot_number = dot.group(1) if dot else None
        result.update(
            {
                "object_type": "Reifensatz",
                "object_class": "Reifen",
                "brand": "Michelin" if "michelin" in text else None,
                "tire_size": None,
                "dot_number": dot_number,
                "production_week": int(dot_number[:2]) if dot_number else None,
                "production_year": 2000 + int(dot_number[2:]) if dot_number else None,
                "estimated_age_years": round(date.today().year - (2000 + int(dot_number[2:])), 1) if dot_number else None,
                "age_source": "dot" if dot_number else "unbekannt",
                "age_verification_status": "bestaetigt" if dot_number else "offen",
                "commercial_category": "kundenware",
                "requires_accounting_review": False,
                "missing_fields": ["Profiltiefe"],
                "recommended_tasks": [{"role": "Erfasser", "task": "Profiltiefe nachtragen"}],
                "recommended_status": "nacharbeit_erfasser",
                "confidence": 0.74,
            }
        )
        object_class = "reifen"
    elif object_class == "hebebuehne" or "hebeb" in text or "bühne" in text or "buehne" in text:
        result.update(
            {
                "object_type": "Hebebühne",
                "object_class": "Hebebühne",
                "brand": "Nussbaum" if "nussbaum" in text else None,
                "commercial_category": "anlagevermoegen",
                "requires_accounting_review": True,
                "missing_fields": ["Typenschildfoto", "Seriennummer", "Tragfähigkeit"],
                "required_evidence_missing": ["nameplate"],
                "recommended_status": "nacharbeit_erfasser",
                "confidence": 0.69,
            }
        )
        object_class = "hebebuehne"
    elif object_class == "wuchtmaschine" or "wucht" in text:
        result.update(
            {
                "object_type": "Wuchtmaschine",
                "object_class": "Wuchtmaschine",
                "commercial_category": "werkstattausstattung",
                "requires_accounting_review": True,
                "missing_fields": ["Typenschildfoto", "Seriennummer"],
                "required_evidence_missing": ["nameplate"],
                "recommended_status": "nacharbeit_erfasser",
                "confidence": 0.68,
            }
        )
        object_class = "wuchtmaschine"
    elif object_class == "reifenmontiermaschine" or "reifenmontier" in text or "montiermaschine" in text:
        result.update(
            {
                "object_type": "Reifenmontiermaschine",
                "object_class": "Reifenmontiermaschine",
                "commercial_category": "werkstattausstattung",
                "requires_accounting_review": True,
                "missing_fields": ["Typenschildfoto", "Seriennummer"],
                "required_evidence_missing": ["nameplate"],
                "recommended_status": "nacharbeit_erfasser",
                "confidence": 0.68,
            }
        )
        object_class = "reifenmontiermaschine"
    elif object_class == "diagnosegeraet" or "diagnose" in text or "tester" in text:
        result.update(
            {
                "object_type": "Diagnosegerät",
                "object_class": "Diagnosegerät",
                "commercial_category": "gwg_pruefen",
                "requires_accounting_review": True,
                "missing_fields": ["Seriennummer"],
                "recommended_status": "nacharbeit_pruefer",
                "confidence": 0.66,
            }
        )
        object_class = "diagnosegeraet"
    elif object_class == "kompressor" or "kompressor" in text or "druckluft" in text:
        result.update(
            {
                "object_type": "Kompressor",
                "object_class": "Kompressor",
                "commercial_category": "werkstattausstattung",
                "requires_accounting_review": True,
                "missing_fields": ["Typenschildfoto", "Seriennummer"],
                "required_evidence_missing": ["nameplate"],
                "recommended_status": "nacharbeit_erfasser",
                "confidence": 0.66,
            }
        )
        object_class = "kompressor"
    elif "dell" in text:
        result["brand"] = "Dell"
        result["object_type"] = "Monitor"

    special_matches = select_special_tool_references(transcripts, object_class_name, limit=1)
    if special_matches:
        result["special_tool_matches"] = special_matches
    if special_matches and text:
        match = special_matches[0]
        result.update(
            {
                "object_type": match.get("designation_de") or result["object_type"],
                "category": match.get("category_hint"),
                "model": match.get("vag_no") or result.get("model"),
                "commercial_category": "werkstattausstattung",
                "requires_accounting_review": True,
                "recommended_status": "pruefen",
                "confidence": max(float(result.get("confidence") or 0), 0.7),
                "notes": f"Referenztreffer aus Spezialwerkzeug-Wissensbasis: {match.get('source_file')}",
            }
        )
    history_matches = select_inventory_history_references(transcripts, object_class_name, limit=1)
    if history_matches:
        result["inventory_history_matches"] = history_matches
    if history_matches and text:
        match = history_matches[0]
        notes = [str(match.get("source_file") or "Bestandsunterlage")]
        if match.get("action"):
            notes.append(f"Maßnahme: {match.get('action')}")
        if match.get("note"):
            notes.append(f"Hinweis: {match.get('note')}")
        result.update(
            {
                "object_type": match.get("designation_de") or result["object_type"],
                "model": match.get("tool_no") or result.get("model"),
                "recommended_status": "nacharbeit_pruefer",
                "requires_review": True,
                "confidence": max(float(result.get("confidence") or 0), 0.72),
                "notes": " | ".join(notes),
            }
        )
        missing_fields = list(result.get("missing_fields") or [])
        if match.get("uvv_due") or match.get("maintenance_due") or match.get("inspection_book_missing"):
            missing_fields.append("Wartung/UVV prüfen")
        if match.get("missing"):
            missing_fields.append("Sollbestand prüfen")
        if match.get("defective"):
            missing_fields.append("Defekt prüfen")
        result["missing_fields"] = sorted(set(missing_fields))

    return result


def ollama_model_candidates(primary_model: str | None, secondary_models: list[str] | None = None) -> list[str]:
    candidates = [
        primary_model,
        *(secondary_models or []),
        settings.ollama_fallback_model,
        settings.ollama_model,
    ]
    unique: list[str] = []
    for candidate in candidates:
        model = str(candidate or "").strip()
        if model and model not in unique:
            unique.append(model)
    return unique


def ollama_url_for_model(model: str | None) -> str:
    model_name = str(model or "").lower()
    if model_name.startswith("glm-ocr") and settings.ollama_local_url and not settings.ollama_api_key:
        return settings.ollama_local_url
    return settings.ollama_url


def ollama_chat_url(model: str | None = None) -> str:
    base = ollama_url_for_model(model).rstrip("/")
    api_base = base if base.endswith("/api") else f"{base}/api"
    return f"{api_base}/chat"


def ollama_headers(model: str | None = None) -> dict[str, str]:
    if not settings.ollama_api_key:
        return {}
    if "ollama.com" not in ollama_url_for_model(model):
        return {}
    return {"Authorization": f"Bearer {settings.ollama_api_key}"}


def call_ollama_json(prompt: dict[str, Any], images: list[str], primary_model: str | None, secondary_models: list[str] | None = None) -> tuple[dict[str, Any], str]:
    errors: list[str] = []
    for model in ollama_model_candidates(primary_model, secondary_models):
        payload = {
            "model": model,
            "stream": False,
            "format": "json",
            "messages": [
                {
                    "role": "user",
                    "content": json.dumps(prompt, ensure_ascii=False),
                    **({"images": images} if images else {}),
                }
            ],
        }
        try:
            with httpx.Client(timeout=settings.ollama_timeout_seconds) as client:
                response = client.post(ollama_chat_url(model), json=payload, headers=ollama_headers(model))
                response.raise_for_status()
            content = response.json().get("message", {}).get("content", "{}")
            return parse_ollama_json(content), model
        except Exception as exc:  # Ollama Cloud/local fallback path
            errors.append(f"{model}: {type(exc).__name__}: {str(exc)[:180]}")
    raise RuntimeError("Ollama JSON call failed: " + " | ".join(errors))


def photo_to_base64(path: Any) -> str | None:
    if not path:
        return None
    try:
        with open(path, "rb") as handle:
            return base64.b64encode(handle.read()).decode("ascii")
    except OSError:
        return None


def normalize_text_list(value: Any) -> list[str]:
    if isinstance(value, dict):
        return [f"{key}: {text}" for key, raw in value.items() if (text := first_text(raw))]
    if isinstance(value, list):
        return [text for raw in value if (text := first_text(raw))]
    text = first_text(value)
    if not text:
        return []
    return [line.strip() for line in text.splitlines() if line.strip()]


def clean_extracted_text(value: Any) -> str | None:
    text = first_text(value)
    if not text:
        return None
    lowered = text.lower().strip(" .:-")
    if lowered in {"unknown", "unbekannt", "n/a", "na", "none", "null", "nicht lesbar", "nicht sichtbar", "-"}:
        return None
    return text


def extract_labelled_year(candidate: Any, raw_text: str | None) -> str | None:
    candidate_match = re.search(r"\b(19[8-9][0-9]|20[0-3][0-9])\b", str(candidate or ""))
    raw = raw_text or ""
    label = r"(?:baujahr|bj\.?|herstelljahr|hergestellt|mfg\.?|manufactured|year of manufacture|year)"
    if candidate_match:
        year = candidate_match.group(1)
        if raw and not re.search(rf"{label}.{{0,40}}{re.escape(year)}|{re.escape(year)}.{{0,40}}{label}", raw, flags=re.IGNORECASE | re.DOTALL):
            return None
        return year
    raw_match = re.search(rf"{label}.{{0,40}}\b(19[8-9][0-9]|20[0-3][0-9])\b", raw, flags=re.IGNORECASE | re.DOTALL)
    return raw_match.group(1) if raw_match else None


def build_nameplate_remark(extraction: dict[str, Any]) -> str | None:
    lines = ["Typenschild ausgelesen:"]
    for label, key in [
        ("Hersteller", "manufacturer"),
        ("Modell", "model"),
        ("Typ", "type_designation"),
        ("Seriennummer", "serial_number"),
        ("Baujahr", "construction_year"),
    ]:
        value = first_text(extraction.get(key))
        if value:
            lines.append(f"{label}: {value}")
    specs = normalize_text_list(extraction.get("technical_specs"))
    if specs:
        lines.append("Technische Angaben: " + "; ".join(specs))
    raw_text = first_text(extraction.get("raw_text"))
    if raw_text:
        lines.append("Rohtext:")
        lines.append(raw_text)
    return "\n".join(lines) if len(lines) > 1 else None


def normalize_nameplate_extraction(parsed: dict[str, Any], fallback_object_type: str | None = None) -> dict[str, Any]:
    raw_text = first_text(parsed.get("raw_text"), "\n".join(normalize_text_list(parsed.get("text_lines"))))
    uncertain_fields = normalize_text_list(parsed.get("uncertain_fields"))
    uncertain_keys = " ".join(uncertain_fields).lower()
    serial_number = clean_extracted_text(first_text(parsed.get("serial_number"), parsed.get("serial"), parsed.get("sn")))
    if serial_number and ("serial" in uncertain_keys or "serien" in uncertain_keys):
        serial_number = None
    construction_year = extract_labelled_year(parsed.get("construction_year"), raw_text)
    if construction_year and ("construction_year" in uncertain_keys or "baujahr" in uncertain_keys):
        construction_year = None

    technical_specs = normalize_text_list(parsed.get("technical_specs"))
    manufacturer = clean_extracted_text(first_text(parsed.get("manufacturer"), parsed.get("brand")))
    model = clean_extracted_text(parsed.get("model"))
    type_designation = clean_extracted_text(first_text(parsed.get("type_designation"), parsed.get("type"), parsed.get("typ")))
    suggested_object_type = clean_extracted_text(parsed.get("suggested_object_type"))

    spec_lines = []
    for label, value in [
        ("Hersteller", manufacturer),
        ("Modell", model),
        ("Typ", type_designation),
        ("Seriennummer", serial_number),
        ("Baujahr", construction_year),
    ]:
        if value:
            spec_lines.append(f"{label}: {value}")
    spec_lines.extend(technical_specs)
    extraction = {
        "raw_text": raw_text,
        "manufacturer": manufacturer,
        "model": model,
        "type_designation": type_designation,
        "serial_number": serial_number,
        "construction_year": construction_year,
        "technical_specs": technical_specs,
        "suggested_object_type": suggested_object_type or clean_extracted_text(fallback_object_type),
        "suggested_specification": clean_extracted_text(parsed.get("suggested_specification")) or ("; ".join(spec_lines) if spec_lines else None),
        "suggested_remark": clean_extracted_text(parsed.get("suggested_remark")),
        "confidence": clamp_confidence(parsed.get("confidence"), 0.68),
        "uncertain_fields": uncertain_fields,
    }
    extraction["suggested_remark"] = extraction["suggested_remark"] or build_nameplate_remark(extraction)
    return extraction


def merge_suggestion_text(existing: Any, addition: Any, separator: str = "\n") -> str | None:
    left = first_text(existing)
    right = first_text(addition)
    if not left:
        return right
    if not right:
        return left
    if right.lower() in left.lower():
        return left
    return f"{left}{separator}{right}"


def merge_nameplate_extraction(result: dict[str, Any], extraction: dict[str, Any]) -> dict[str, Any]:
    result["nameplate_extraction"] = extraction
    for target, source in [
        ("serial_number", "serial_number"),
        ("construction_year", "construction_year"),
        ("manufacturer", "manufacturer"),
        ("brand", "manufacturer"),
        ("model", "model"),
    ]:
        value = first_text(extraction.get(source))
        if value and not first_text(result.get(target)):
            result[target] = value

    suggested_fields = dict(result.get("suggested_fields") or {})
    current_name = first_text(suggested_fields.get("object_type"), result.get("object_type"), result.get("object_name"))
    nameplate_name = first_text(extraction.get("suggested_object_type"))
    if nameplate_name and (not current_name or current_name.lower().startswith(("unbekannt", "vermutlich unbekannt"))):
        suggested_fields["object_type"] = nameplate_name
        result["object_type"] = nameplate_name
        result["object_name"] = nameplate_name
    if extraction.get("serial_number"):
        suggested_fields["serial_number"] = extraction["serial_number"]
    if extraction.get("construction_year"):
        suggested_fields["construction_year"] = first_text(suggested_fields.get("construction_year"), extraction["construction_year"])
    if extraction.get("suggested_specification"):
        suggested_fields["specification"] = merge_suggestion_text(suggested_fields.get("specification"), extraction["suggested_specification"], "; ")
        result["specification"] = merge_suggestion_text(result.get("specification"), extraction["suggested_specification"], "; ")
    if extraction.get("suggested_remark"):
        suggested_fields["remark"] = merge_suggestion_text(suggested_fields.get("remark"), extraction["suggested_remark"])
        result["suggested_remark"] = merge_suggestion_text(result.get("suggested_remark"), extraction["suggested_remark"])
    result["suggested_fields"] = suggested_fields

    detection = dict(result.get("bga_detection") or {})
    detection.update(
        {
            "manufacturer": result.get("manufacturer") or result.get("brand"),
            "model": result.get("model"),
            "serial_number": result.get("serial_number"),
            "specification": result.get("specification"),
            "suggested_remark": result.get("suggested_remark"),
            "nameplate_extraction": extraction,
            "suggested_fields": suggested_fields,
        }
    )
    result["bga_detection"] = detection
    return result


def build_nameplate_extraction(nameplate_images: list[str], item: dict[str, Any]) -> tuple[dict[str, Any], str]:
    prompt = {
        "task": "Lies ein Typenschild/Serienschild aus. Antworte ausschließlich als JSON.",
        "goal": "Extrahiere nur Daten, die auf dem Schild klar lesbar sind. Erfinde nichts.",
        "object_hint": item.get("object_type") or item.get("object_class_name"),
        "rules": [
            "raw_text enthält den vollständigen lesbaren Schildtext mit Zeilenumbrüchen.",
            "serial_number nur setzen, wenn Seriennummer, S/N, SN, Serial No, Fabrik-Nr. oder vergleichbar eindeutig erkennbar ist.",
            "construction_year nur setzen, wenn Baujahr, Herstelljahr, MFG year oder Year of manufacture eindeutig neben einer Jahreszahl steht.",
            "suggested_object_type ist eine kurze deutsche Objektbezeichnung, nur wenn aus Schild oder Kontext ableitbar.",
            "technical_specs enthält wichtige technische Werte wie Spannung, Leistung, Traglast, Drehzahl, Druck, Maße oder CE/Norm-Hinweise.",
            "uncertain_fields listet Felder, die unsicher oder teilweise verdeckt sind.",
        ],
        "required_schema": {
            "raw_text": "string|null",
            "manufacturer": "string|null",
            "model": "string|null",
            "type_designation": "string|null",
            "serial_number": "string|null",
            "construction_year": "string|null",
            "technical_specs": ["string"],
            "suggested_object_type": "string|null",
            "suggested_specification": "string|null",
            "suggested_remark": "string|null",
            "confidence": "number",
            "uncertain_fields": ["string"],
        },
    }
    parsed, model_used = call_ollama_json(prompt, nameplate_images[:2], settings.ollama_ocr_model, [settings.ollama_vision_model])
    return normalize_nameplate_extraction(parsed, item.get("object_type") or item.get("object_class_name")), model_used


def build_ollama_suggestion(item_id: str, fallback: dict[str, Any], mode: str = "fast") -> dict[str, Any]:
    normalized_mode = "review" if mode == "review" else "fast"
    item = fetch_one(
        """
        SELECT i.*, oc.slug AS object_class_slug, oc.name AS object_class_name
        FROM inventory_items i
        LEFT JOIN object_classes oc ON oc.id = i.object_class_id
        WHERE i.id = %s
        """,
        (item_id,),
    ) or {}
    notes = fetch_all("SELECT transcript FROM item_audio_notes WHERE item_id = %s", (item_id,))
    photos = fetch_all(
        """
        SELECT photo_type, original_path
        FROM item_photos
        WHERE item_id = %s
        ORDER BY
          CASE
            WHEN photo_type IN ('object', 'object_front') THEN 0
            WHEN photo_type IN ('nameplate', 'type_plate') THEN 1
            WHEN photo_type IN ('condition_detail', 'object_back', 'uvv_label') THEN 2
            ELSE 3
          END,
          uploaded_at DESC
        LIMIT 4
        """,
        (item_id,),
    )
    transcripts = [str(note.get("transcript") or "") for note in notes if note.get("transcript")]
    photo_types = [str(photo.get("photo_type")) for photo in photos if photo.get("photo_type")]
    has_object_photo = any(photo_type in {"object", "object_front"} for photo_type in photo_types)
    has_nameplate_photo = any(photo_type in {"nameplate", "type_plate"} for photo_type in photo_types)
    if not has_object_photo and not has_nameplate_photo:
        fallback["notes"] = "KI-Vorschlag übersprungen: kein Objekt- oder Typenschildfoto vorhanden."
        fallback["_model_used"] = "not-started-no-object-photo"
        return fallback
    fallback["_photo_types"] = photo_types
    if normalized_mode == "fast":
        special_tool_matches: list[dict[str, Any]] = []
        inventory_history_matches: list[dict[str, Any]] = []
        learning_examples: list[dict[str, Any]] = []
    else:
        special_tool_matches = select_special_tool_references(transcripts, item.get("object_class_name"), limit=25)
        inventory_history_matches = select_inventory_history_references(transcripts, item.get("object_class_name"), limit=15)
        learning_examples = select_learning_examples(transcripts, item.get("object_class_name"), item.get("object_type"), limit=8)
    vision_images: list[str] = []
    nameplate_images: list[str] = []
    detail_images: list[str] = []
    for photo in photos:
        encoded = photo_to_base64(photo.get("original_path"))
        if not encoded:
            continue
        photo_type = str(photo.get("photo_type") or "")
        if photo_type in {"object", "object_front"}:
            vision_images.append(encoded)
        elif photo_type in {"nameplate", "type_plate"}:
            nameplate_images.append(encoded)
        else:
            detail_images.append(encoded)
    images = vision_images[:3]

    prompt = {
        "task": "Analysiere ein einzelnes Inventarobjekt der Betriebs- und Geschäftsausstattung. Antworte ausschließlich als JSON.",
        "primary_goal": "Erkenne zuerst das sichtbare Hauptobjekt im Objektfoto. Trenne es sauber von Hintergrundobjekten wie Monitoren, Tastaturen, Kabeln, Laptops oder Tischflächen.",
        "object_class_hint": item.get("object_class_name"),
        "object_class_slug": item.get("object_class_slug"),
        "condition_hint": item.get("condition"),
        "inventory_id": item.get("inventory_id"),
        "photo_types": photo_types,
        "photo_priority": [
            "Bild 1 ist das wichtigste Objektfoto und bestimmt object_name/object_class.",
            "Typenschild-/type_plate-Fotos werden zusätzlich mit einem OCR-Modell ausgelesen; erfinde daraus im Objektmodell nichts.",
            "UVV-, Zustands- und Detailfotos stützen Zustand und Bemerkung, dürfen die Objektart aber nicht gegen das Objektfoto überschreiben.",
        ],
        "transcripts": transcripts,
        "allowed_bga_object_classes": BGA_OBJECT_CLASSES,
        "bga_object_candidates": BGA_OBJECT_CANDIDATES,
        "prompt_tests": BGA_PROMPT_TEST_CASES,
        "reference_catalog": WORKSHOP_REFERENCE_CATALOG,
        "special_tool_matches": special_tool_matches,
        "inventory_history_matches": inventory_history_matches,
        "learning_examples": learning_examples,
        "classification_rules": [
            "Das wichtigste Ergebnis ist die korrekte Objektart. Wähle object_class zuerst exakt aus allowed_bga_object_classes. Erfinde keine weiteren Klassen.",
            "Arbeite wie eine Inventurhilfe: zuerst Hauptobjekt erkennen, dann erst Hersteller/Modell/Alter/Wert prüfen.",
            "Antworte nur mit belegbaren Vorschlägen. Keine Fantasiewerte, keine erfundenen Hersteller, keine geratenen Modelle.",
            "Wenn keine Klasse sicher passt, nutze object_class='Unklar', object_name='vermutlich ...', confidence unter 0.75 und requires_manual_review=true.",
            "Für eindeutige Objekte setze eine konkrete Bezeichnung, z. B. object_name='Computermaus' und object_class='Computermaus'.",
            "Computermaus: handgroßes Zeigegerät mit linker/rechter Taste, Scrollrad, Gehäuse zum Greifen, oft Kabel/USB/Funk. Eine Computermaus darf nicht als Monitor, Tastatur oder Notebook klassifiziert werden, nur weil solche Dinge im Hintergrund sichtbar sind.",
            "Wenn eine Computermaus eindeutig sichtbar ist, lautet object_name exakt 'Computermaus', object_class exakt 'Computermaus', commercial_category='it_ausstattung'.",
            "Nespresso, Kapselmaschine, Espressomaschine oder kleine Kaffeemaschine erhalten object_name exakt 'Kaffeemaschine' und object_class exakt 'Kaffeemaschine'.",
            "Tastatur: viele Tasten in einem Raster. Monitor: einzelner Bildschirm mit Displayfläche. Notebook/Laptop: Bildschirm und Tastatur fest zusammen in einem aufklappbaren Gerät.",
            "Wenn mehrere Gegenstände im Bild sind, bewerte das zentrale, am nächsten fotografierte oder per Sprache beschriebene Objekt als Hauptobjekt.",
            "Nutze ausschliesslich object_front/object-Fotos für object_name und object_class. type_plate/nameplate-Fotos sind nur für Hersteller, Modell, Seriennummer, Baujahr und Spezifikation.",
            "Nutze die Objektklasse aus der Auswahl als starken Hinweis, korrigiere sie aber, wenn Foto und Sprache eindeutig etwas anderes zeigen.",
            "Nutze learning_examples als kuratierte Beispiele aus früheren menschlichen Korrekturen; sie sind wichtiger als eine allgemeine Vermutung.",
            "Wenn learning_examples eine typische Verwechslung zeigen, korrigiere konservativ und setze requires_review=true.",
            "Verwechsle IT-Peripherie nicht mit Monitor: Computermaus, Maus und Mouse erhalten object_class='Computermaus'; Tastatur und Keyboard erhalten object_class='Tastatur'.",
            "Laptop, Notebook, ThinkPad, EliteBook, ProBook und MacBook erhalten object_class='Laptop/PC', nicht Monitor.",
            "Nur ein sichtbarer einzelner Bildschirm ohne Tastatur-Unterteil ist Monitor. Ein aufgeklappter Laptop ist Laptop/PC.",
            "Nutze special_tool_matches für exakte VAS-/V.A.G-/ASE-Nummern, Spezialwerkzeugnamen und bekannte Werkzeugbezeichnungen.",
            "Nutze inventory_history_matches für frühere Bestands-, Mängel-, UVV-, Wartungs- und Soll-Hinweise. Diese Hinweise sind prüfpflichtig und dürfen die schnelle Erfassung nicht blockieren.",
            "Wenn special_tool_matches Treffer enthält, bevorzuge deren deutsche Bezeichnung, VAG-Nummer und Quelle als Kandidat, aber kennzeichne das Ergebnis weiterhin als prüfpflichtig.",
            "Erfinde niemals Hersteller, Modell, Baujahr, Seriennummer oder Preis. Wenn nicht sichtbar oder nicht aus Typenschild/Sprache/Beispiel belegbar: null oder unbekannt.",
            "Alter und Wert nur setzen, wenn eine belastbare Quelle sichtbar oder aus Typenschild/Modell eindeutig begründbar ist. Keine pauschalen Standardwerte wie 7 Jahre oder 11 Euro erfinden.",
            "Werte sind Gebrauchtmarktwerte, keine Neupreise und keine Ersatzwerte. Ohne Webrecherche, Beleg oder geprüfte Referenz bleibt estimated_value_eur=null.",
            "Für Computermaus, Tastatur, Kaffeemaschine/Nespresso, Standardtelefon, Standardladegerät und sonstige Kleinteile gilt: estimated_value_eur=null, ausser eine belastbare Gebrauchtmarktquelle ist vorhanden.",
            "Eine Computermaus über 100 EUR und eine Kaffeemaschine/Nespresso über 80 EUR sind ohne klaren Gebrauchtmarktbeleg unplausibel.",
            "Wenn Alter oder Wert nur geraten wären: estimated_age_years=null, estimated_value_eur=null, age_source=unbekannt, age_verification_status=offen.",
            "Wenn unsicher: object_name als beste Vermutung mit 'vermutlich', confidence unter 0.75, uncertainty_reason füllen und requires_manual_review=true.",
            "Wuchtmaschine: Radaufnahme/Spindel, Schutzhaube und Bedienpanel sprechen klar für Wuchtmaschine.",
            "Reifenmontiermaschine: Montageteller, Montagearm, Abdrückschaufel und Pedale sprechen klar für Reifenmontiermaschine.",
            "Hebebühne: Säulen, Scherenhub, Tragarme, Plattform und Traglastschild sprechen klar für Hebebühne.",
            "Gib kaufmännische Daten nicht endgültig frei; setze bei Maschinen in der Regel requires_accounting_review=true.",
            "Wenn Typenschild oder Seriennummer für Maschinen fehlen, erzeuge missing_fields und recommended_status=nacharbeit_erfasser.",
        ],
        "required_schema": {
            "object_name": "string",
            "object_class": "string exakt aus allowed_bga_object_classes",
            "confidence": "number",
            "uncertainty_reason": "string|null",
            "suggested_fields": {
                "object_type": "string|null",
                "specification": "string|null",
                "condition": "string|null",
                "serial_number": "string|null",
                "construction_year": "string|null",
                "remark": "string|null",
            },
            "requires_manual_review": "boolean",
            "manufacturer": "string|null",
            "manufacturer_source": "type_plate|object_photo|audio|learning_example|null",
            "model": "string|null",
            "model_source": "type_plate|object_photo|audio|learning_example|null",
            "specification": "string|null",
            "visible_features": ["string"],
            "condition_guess": "neu|sehr_gut|gut|gebraucht|reparaturbeduerftig|defekt|aussondern|null",
            "suggested_remark": "string|null",
            "estimated_age_years": "number|null",
            "estimated_value_eur": "number|null",
            "estimated_value_confidence": "number|null",
            "estimated_value_reason": "string|null",
            "value_source": "webrecherche|gebrauchtmarkt|beleg|referenzpreis|gepruefte_referenz|null",
            "value_requires_review": "boolean",
            "age_confidence": "number|null",
            "age_reason": "string|null",
            "age_requires_review": "boolean",
            "object_type": "string",
            "brand": "string|null",
            "model": "string|null",
            "serial_number": "string|null",
            "condition": "neu|sehr_gut|gut|gebraucht|reparaturbeduerftig|defekt|aussondern|null",
            "commercial_category": "string",
            "requires_accounting_review": "boolean",
            "missing_fields": ["string"],
            "required_evidence_missing": ["string"],
            "recommended_tasks": [{"role": "string", "task": "string"}],
            "recommended_status": "string",
            "notes": "string",
        },
    }
    if normalized_mode == "fast":
        prompt.update(
            {
                "task": "Schnelle Handy-Erfassung eines Inventarobjekts. Antworte ausschliesslich als kompaktes JSON.",
                "primary_goal": "Erkenne aus dem Objektfoto nur Bezeichnung, grobe Klasse und optional Zustand. Lies Typenschildfotos nur fuer Hersteller, Modell, Seriennummer, Baujahr und Spezifikation.",
                "reference_catalog": [],
                "special_tool_matches": [],
                "inventory_history_matches": [],
                "learning_examples": [],
                "prompt_tests": [],
                "classification_rules": [
                    "Arbeite schnell und konservativ: richtige Bezeichnung ist wichtiger als Details.",
                    "Nutze ausschliesslich object_front/object-Fotos fuer object_name und object_class.",
                    "type_plate/nameplate-Fotos dienen nur OCR-Feldern: Hersteller, Modell, Seriennummer, Baujahr, Spezifikation, Bemerkung.",
                    "Typenschild darf die Objektklasse nicht gegen das Objektfoto ueberschreiben.",
                    "Computermaus muss exakt object_name='Computermaus' und object_class='Computermaus' sein, wenn eine Maus sichtbar ist.",
                    "Eine Computermaus darf nicht Monitor, Tastatur, Laptop oder Notebook werden, nur weil diese im Hintergrund sichtbar sind.",
                    "Nespresso, Kapselmaschine, Espressomaschine oder Kaffeemaschine erhalten object_name='Kaffeemaschine' und object_class='Kaffeemaschine'.",
                    "Wenn unsicher: object_name als beste kurze Vermutung, confidence unter 0.75 und requires_manual_review=true.",
                    "Erfinde niemals Hersteller, Modell, Baujahr, Seriennummer, Alter oder Wert.",
                    "Gib keine Alters- oder Wertschätzung aus. estimated_age_years und estimated_value_eur muessen null bleiben.",
                ],
                "required_schema": {
                    "object_name": "string",
                    "object_class": "string exakt aus allowed_bga_object_classes",
                    "confidence": "number",
                    "uncertainty_reason": "string|null",
                    "suggested_fields": {
                        "object_type": "string|null",
                        "specification": "string|null",
                        "condition": "string|null",
                        "serial_number": "string|null",
                        "construction_year": "string|null",
                        "remark": "string|null",
                    },
                    "requires_manual_review": "boolean",
                    "manufacturer": "string|null",
                    "manufacturer_source": "type_plate|object_photo|audio|null",
                    "model": "string|null",
                    "model_source": "type_plate|object_photo|audio|null",
                    "specification": "string|null",
                    "visible_features": ["string"],
                    "condition_guess": "neu|sehr_gut|gut|gebraucht|reparaturbeduerftig|defekt|aussondern|null",
                    "suggested_remark": "string|null",
                    "estimated_age_years": "null",
                    "estimated_value_eur": "null",
                    "object_type": "string",
                    "brand": "string|null",
                    "serial_number": "string|null",
                    "condition": "neu|sehr_gut|gut|gebraucht|reparaturbeduerftig|defekt|aussondern|null",
                    "commercial_category": "string",
                    "requires_accounting_review": "boolean",
                    "missing_fields": ["string"],
                    "required_evidence_missing": ["string"],
                    "recommended_tasks": [{"role": "string", "task": "string"}],
                    "recommended_status": "string",
                    "notes": "string",
                },
            }
        )
    if images:
        raw_result, vision_model_used = call_ollama_json(prompt, images, settings.ollama_vision_model)
        parsed = normalize_ollama_result(raw_result, fallback)
        result = {**fallback, **{key: value for key, value in parsed.items() if value is not None}}
    else:
        vision_model_used = "not-started-no-object-photo"
        result = dict(fallback)
    quick_it = classify_it_peripheral(" ".join(transcripts), str(result.get("object_type") or ""))
    if quick_it:
        _, update = quick_it
        result.update(update)
        result = {**result, **normalize_ollama_result(result, fallback)}
    if special_tool_matches:
        result["special_tool_matches"] = special_tool_matches[:5]
    if inventory_history_matches:
        result["inventory_history_matches"] = inventory_history_matches[:5]
    if learning_examples:
        result["learning_examples"] = learning_examples[:5]
    used_models = [vision_model_used]
    if nameplate_images:
        try:
            extraction, ocr_model_used = build_nameplate_extraction(nameplate_images, item)
            result = merge_nameplate_extraction(result, extraction)
            used_models.append(f"nameplate:{ocr_model_used}")
        except Exception as exc:
            result["nameplate_extraction_error"] = f"{type(exc).__name__}: {str(exc)[:180]}"
            used_models.append("nameplate:failed")
    result["_model_used"] = "+".join(used_models)
    result["notes"] = result.get("notes") or f"Ollama-Auswertung mit {' + '.join(used_models)}"
    apply_suggestion_to_item(item_id, result, item.get("object_class_slug") or "monitor")
    return result


def parse_ollama_json(content: str) -> dict[str, Any]:
    text = (content or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```$", "", text).strip()
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, flags=re.DOTALL)
        if not match:
            raise
        value = json.loads(match.group(0))
    if not isinstance(value, dict):
        raise ValueError("Ollama response JSON is not an object")
    return value


def normalize_ollama_result(parsed: dict[str, Any], fallback: dict[str, Any]) -> dict[str, Any]:
    result = dict(parsed)
    object_name = first_text(result.get("object_name"), result.get("object_type"))
    normalized_object_class = normalize_bga_object_class(result.get("object_class"), object_name)
    candidate = bga_candidate_for_class(normalized_object_class)
    confidence = clamp_confidence(result.get("confidence"), 0.62)

    if candidate and normalized_object_class not in {"Unklar", "Sonstiges"}:
        object_name = candidate["object_name"]
        result["commercial_category"] = result.get("commercial_category") or candidate.get("category")
    elif normalized_object_class == "Unklar":
        object_name = object_name or "vermutlich unbekanntes Objekt"
    elif normalized_object_class == "Sonstiges":
        object_name = object_name or "Sonstige Ausstattung"

    result["object_name"] = object_name
    result["object_type"] = object_name
    result["object_class"] = normalized_object_class
    result["confidence"] = confidence

    if normalized_object_class == "Unklar":
        if result.get("object_name") and not str(result.get("object_name")).lower().startswith("vermutlich"):
            result["object_name"] = f"vermutlich {result['object_name']}"
            result["object_type"] = result["object_name"]
        result["requires_manual_review"] = True
        result["requires_review"] = True
        if not result.get("uncertainty_reason"):
            result["uncertainty_reason"] = "Objektklasse nicht eindeutig aus der festen BGA-Klassenliste ableitbar."
        result["confidence"] = confidence if 0 < confidence < 0.75 else 0.6
    elif confidence < 0.78:
        result["requires_manual_review"] = True
        result["requires_review"] = True
        result["uncertainty_reason"] = result.get("uncertainty_reason") or "KI-Sicherheit unter Praxis-Schwelle."
    else:
        result["requires_manual_review"] = bool(result.get("requires_manual_review", True))
        result["requires_review"] = bool(result.get("requires_review", result["requires_manual_review"]))

    manufacturer = first_text(result.get("manufacturer"), result.get("brand"))
    if manufacturer:
        result["manufacturer"] = manufacturer
        result["brand"] = manufacturer
    model = first_text(result.get("model"))
    if model:
        result["model"] = model
    serial_number = first_text(result.get("serial_number"))
    if serial_number:
        result["serial_number"] = serial_number
    specification = first_text(result.get("specification"))
    condition_guess = first_text(result.get("condition_guess"), result.get("condition"), fallback.get("condition"))
    if condition_guess:
        result["condition_guess"] = condition_guess
        result["condition"] = condition_guess

    if normalized_object_class == "Computermaus":
        result["object_name"] = "Computermaus"
        result["object_type"] = "Computermaus"
        result["commercial_category"] = "it_ausstattung"
        result["requires_accounting_review"] = False
        result["recommended_status"] = "pruefen"
    elif normalized_object_class in {"Tastatur", "Monitor", "Drucker", "Scanner", "Laptop/PC", "Telefon"}:
        result["commercial_category"] = "it_ausstattung"
        result["requires_accounting_review"] = normalized_object_class in {"Laptop/PC"}
    elif normalized_object_class == "Kaffeemaschine":
        result["object_name"] = "Kaffeemaschine"
        result["object_type"] = "Kaffeemaschine"
        result["commercial_category"] = "betriebsmittel"
        result["requires_accounting_review"] = False
        result["recommended_status"] = "pruefen"

    normalize_estimates(result, normalized_object_class, result["confidence"])

    suggested_fields = result.get("suggested_fields")
    if not isinstance(suggested_fields, dict):
        suggested_fields = {}
    default_specs = {
        "Computermaus": "Computermaus, kabelgebunden/kabellos falls erkennbar",
        "Tastatur": "Tastatur, Anschluss/Layout falls erkennbar",
        "Monitor": "Monitor, Größe/Anschluss falls erkennbar",
        "Laptop/PC": "Laptop/PC, Hersteller/Modell nur falls sichtbar",
        "Kaffeemaschine": "Kaffeemaschine/Kapselmaschine, Hersteller und Modell nur falls sichtbar",
        "Bürostuhl": "Bürostuhl, Zustand und Ausstattung prüfen",
        "Werkzeugwagen": "Werkzeugwagen, Ausführung und Zustand prüfen",
    }
    spec_value = first_text(suggested_fields.get("specification"), result.get("specification"), default_specs.get(normalized_object_class))
    remark_value = first_text(
        suggested_fields.get("remark"),
        result.get("suggested_remark"),
        result.get("uncertainty_reason"),
        "KI-Vorschlag bitte fachlich prüfen.",
    )
    result["suggested_fields"] = {
        "object_type": first_text(suggested_fields.get("object_type"), result.get("object_name"), result.get("object_type")),
        "specification": spec_value,
        "condition": first_text(suggested_fields.get("condition"), result.get("condition_guess"), result.get("condition")),
        "serial_number": first_text(suggested_fields.get("serial_number"), result.get("serial_number")),
        "construction_year": first_text(suggested_fields.get("construction_year"), result.get("construction_year")),
        "remark": remark_value,
    }
    result["missing_fields"] = bga_review_missing_fields(normalized_object_class, fallback)
    if normalized_object_class == "Unklar":
        result["recommended_status"] = "nacharbeit_pruefer"
    result["required_evidence_missing"] = list(result.get("required_evidence_missing") or [])
    result["bga_detection"] = {
        "object_name": result.get("object_name") or result.get("object_type"),
        "object_class": result.get("object_class"),
        "manufacturer": result.get("manufacturer") or result.get("brand"),
        "model": result.get("model"),
        "serial_number": result.get("serial_number"),
        "specification": result.get("specification"),
        "visible_features": result.get("visible_features") or [],
        "condition_guess": result.get("condition_guess") or result.get("condition"),
        "confidence": result.get("confidence"),
        "uncertainty_reason": result.get("uncertainty_reason"),
        "suggested_remark": result.get("suggested_remark"),
        "estimated_age_years": result.get("estimated_age_years"),
        "estimated_value_eur": result.get("estimated_value_eur"),
        "estimated_value_confidence": result.get("estimated_value_confidence"),
        "estimated_value_reason": result.get("estimated_value_reason"),
        "value_requires_review": bool(result.get("value_requires_review", True)),
        "age_confidence": result.get("age_confidence"),
        "age_reason": result.get("age_reason"),
        "age_requires_review": bool(result.get("age_requires_review", True)),
        "suggested_fields": result["suggested_fields"],
        "allowed_classes": BGA_OBJECT_CLASSES,
        "requires_manual_review": bool(result.get("requires_manual_review") or result.get("requires_review")),
    }
    condition_values = {"neu", "sehr_gut", "gut", "gebraucht", "reparaturbeduerftig", "defekt", "aussondern"}
    commercial_values = {
        "anlagevermoegen",
        "gwg_pruefen",
        "betriebsmittel",
        "ware",
        "kundenware",
        "verbrauchsmaterial",
        "it_ausstattung",
        "bueroausstattung",
        "werkstattausstattung",
        "nicht_relevant",
        "ungeklaert",
    }
    status_values = {
        "erfasst",
        "ki_vorgefuellt",
        "nacharbeit_erfasser",
        "nacharbeit_pruefer",
        "nacharbeit_buchhaltung",
        "nacharbeit_technik",
        "finalisierbar",
        "finalisiert",
        "abweichung",
        "dublette",
        "pruefen",
    }
    commercial_aliases = {
        "it-equipment": "it_ausstattung",
        "it equipment": "it_ausstattung",
        "it-ausstattung": "it_ausstattung",
        "anlagevermögen": "anlagevermoegen",
        "fixed asset": "anlagevermoegen",
        "customer goods": "kundenware",
        "office equipment": "bueroausstattung",
        "workshop equipment": "werkstattausstattung",
        "werkstatt": "werkstattausstattung",
        "werkstattgerät": "werkstattausstattung",
        "workshop machine": "werkstattausstattung",
    }
    status_aliases = {
        "incomplete": fallback.get("recommended_status") or "nacharbeit_pruefer",
        "needs_review": "pruefen",
        "review": "pruefen",
        "missing_fields": fallback.get("recommended_status") or "nacharbeit_pruefer",
    }

    condition = str(result.get("condition") or "").lower()
    condition = condition.replace(" ", "_").replace("reparaturbedürftig", "reparaturbeduerftig")
    if condition and condition not in condition_values:
        result["condition"] = fallback.get("condition")
    elif condition:
        result["condition"] = condition

    commercial = str(result.get("commercial_category") or "").lower().strip()
    commercial = commercial_aliases.get(commercial, commercial)
    result["commercial_category"] = commercial if commercial in commercial_values else fallback.get("commercial_category")

    status = str(result.get("recommended_status") or "").lower().strip()
    status = status_aliases.get(status, status)
    result["recommended_status"] = status if status in status_values else fallback.get("recommended_status")

    if fallback.get("requires_accounting_review") and result.get("commercial_category") in {
        "anlagevermoegen",
        "betriebsmittel",
        "werkstattausstattung",
        "gwg_pruefen",
    }:
        result["requires_accounting_review"] = True
    if result.get("requires_accounting_review") is None:
        result["requires_accounting_review"] = bool(result.get("commercial_category") in {"anlagevermoegen", "werkstattausstattung", "gwg_pruefen"})
    if isinstance(result.get("bga_detection"), dict):
        result["bga_detection"]["estimated_age_years"] = result.get("estimated_age_years")
        result["bga_detection"]["estimated_value_eur"] = result.get("estimated_value_eur")
        result["bga_detection"]["condition_guess"] = result.get("condition")
        result["bga_detection"]["age_requires_review"] = bool(result.get("age_requires_review", True))
        result["bga_detection"]["value_requires_review"] = bool(result.get("value_requires_review", True))
    return result


def apply_suggestion_to_item(item_id: str, result: dict[str, Any], default_slug: str) -> None:
    _ = default_slug
    # KI liefert ab hier nur noch prüfpflichtige Vorschläge. Fachliche Felder
    # werden erst durch aktive Übernahme im UI und anschließendes Speichern geändert.
    execute(
        """
        UPDATE inventory_items
        SET confidence_score = %s, updated_at = now()
        WHERE id = %s
        RETURNING id
        """,
        (result.get("confidence") or 0, item_id),
    )


def create_rework_tasks(item_id: str, suggestion: dict[str, Any]) -> None:
    photos = fetch_all("SELECT photo_type FROM item_photos WHERE item_id = %s", (item_id,))
    photo_types = {photo["photo_type"] for photo in photos}
    for field in suggestion.get("missing_fields", []):
        if field == "Typenschildfoto" and {"nameplate", "type_plate"} & photo_types:
            continue
        if field == "DOT-Foto" and "dot" in photo_types:
            continue
        if field in ["Anschaffungsdatum", "Buchwert", "Anlagenummer"]:
            role = "Auswertung"
        elif field in ["Profiltiefe", "DOT-Foto", "Typenschildfoto"]:
            role = "Erfasser"
        elif field in ["Wartung/UVV prüfen", "Defekt prüfen", "Prüfbuch fehlt"]:
            role = "Technik"
        else:
            role = "Prüfer"
        execute(
            """
            INSERT INTO accounting_tasks (item_id, task_type, assigned_role, missing_field, priority, comment)
            SELECT %s, 'missing_field', %s, %s, 'normal', %s
            WHERE NOT EXISTS (
              SELECT 1 FROM accounting_tasks
              WHERE item_id = %s AND missing_field = %s AND status = 'open'
            )
            RETURNING id
            """,
            (item_id, role, field, f"Hinweis aus KI-Auswertung: {field}", item_id, field),
        )


def finalization_blockers(item_id: str) -> list[str]:
    item = fetch_one("SELECT object_class_id FROM inventory_items WHERE id = %s", (item_id,))
    if not item or not item.get("object_class_id"):
        return ["Objektklasse fehlt"]
    blockers = []
    rows = fetch_all(
        """
        SELECT field_name, field_label, evidence_photo_type
        FROM field_requirements
        WHERE object_class_id = %s AND required = true AND blocks_finalization = true
        ORDER BY sort_order
        """,
        (item["object_class_id"],),
    )
    photos = fetch_all("SELECT photo_type FROM item_photos WHERE item_id = %s", (item_id,))
    photo_types = {p["photo_type"] for p in photos}
    current = fetch_one("SELECT * FROM inventory_items WHERE id = %s", (item_id,)) or {}
    tire_data = (
        fetch_one("SELECT * FROM item_tire_wheel_data WHERE item_id = %s", (item_id,))
        if current.get("inventory_type") == "tires_wheels"
        else None
    ) or {}
    ai_row = fetch_one(
        "SELECT result_json FROM ai_results WHERE item_id = %s AND status = 'completed' ORDER BY created_at DESC LIMIT 1",
        (item_id,),
    )
    ai_result = ai_row.get("result_json") if ai_row else {}

    def is_optional_bga_blocker(*values: object) -> bool:
        if current.get("inventory_type") != "bga":
            return False
        text = " ".join(str(value or "").lower() for value in values)
        optional_tokens = ("uvv", "typenschild", "type_plate", "nameplate", "function_ok")
        return any(token in text for token in optional_tokens) or "funktion nicht geprüft" in text

    open_tasks = fetch_all(
        """
        SELECT missing_field
        FROM accounting_tasks
        WHERE item_id = %s AND status = 'open' AND assigned_role IN ('Erfasser', 'Technik')
        """,
        (item_id,),
    )
    open_task_fields = {task["missing_field"] for task in open_tasks}
    for row in rows:
        field = row["field_name"]
        if is_optional_bga_blocker(field, row["field_label"], row["evidence_photo_type"]):
            continue
        if field == "object_photo":
            if not ({"object", "object_front"} & photo_types):
                blockers.append(row["field_label"])
            continue
        if current.get("inventory_type") == "tires_wheels" and field in {"tire_size", "dot", "season"}:
            value = tire_data.get(field)
            if value in (None, "", "unklar"):
                blockers.append(row["field_label"])
            continue
        if current.get("inventory_type") == "tires_wheels" and field == "tread_depth":
            if tire_data.get("set_type") == "einzelreifen":
                missing_tread = tire_data.get("tread_depth_single") is None
            else:
                missing_tread = any(
                    tire_data.get(name) is None
                    for name in [
                        "tread_depth_front_left",
                        "tread_depth_front_right",
                        "tread_depth_rear_left",
                        "tread_depth_rear_right",
                    ]
                )
            if missing_tread:
                blockers.append(row["field_label"])
            continue
        if row["evidence_photo_type"]:
            accepted = {row["evidence_photo_type"]}
            if row["evidence_photo_type"] == "object_front":
                accepted.add("object")
            if row["evidence_photo_type"] == "type_plate":
                accepted.add("nameplate")
            if not (accepted & photo_types):
                blockers.append(row["field_label"])
            continue
        if field in current and current.get(field) in (None, ""):
            blockers.append(row["field_label"])
        elif field not in current and not ai_result.get(field):
            blockers.append(row["field_label"])
    for missing_field in sorted(open_task_fields):
        if is_optional_bga_blocker(missing_field):
            continue
        if missing_field:
            blockers.append(f"Offene Nacharbeit: {missing_field}")
    return blockers

