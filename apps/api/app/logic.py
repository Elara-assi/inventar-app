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
        INSERT INTO audit_log (entity_type, entity_id, action, new_value_json, reason)
        VALUES (%s, %s, %s, %s::jsonb, %s)
        RETURNING id
        """,
        (entity_type, entity_id, action, json_dumps(new_value), reason),
    )


def json_dumps(value: Any) -> str:
    import json

    return json.dumps(value or {}, default=str)


def classify_it_peripheral(text: str, object_type: str | None = None) -> tuple[str, dict[str, Any]] | None:
    haystack = f"{text} {object_type or ''}".lower()
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
    {"case": "Tastatur", "expected_class": "Tastatur", "expected_object_name": "Tastatur", "guard": "nicht Monitor"},
    {"case": "Monitor", "expected_class": "Monitor", "expected_object_name": "Monitor", "guard": "nur einzelner Bildschirm ohne Tastatur-Unterteil"},
    {"case": "Bürostuhl", "expected_class": "Bürostuhl", "expected_object_name": "Bürostuhl", "guard": "Rollen/Rückenlehne/Sitzfläche"},
    {"case": "Werkzeugwagen", "expected_class": "Werkzeugwagen", "expected_object_name": "Werkzeugwagen", "guard": "rollbarer Schubladenschrank"},
    {"case": "Unbekanntes Gerät", "expected_class": "Unklar", "expected_object_name": "vermutlich ...", "guard": "confidence niedrig und requires_manual_review=true"},
]


def normalize_bga_object_class(value: Any, object_name: Any = None) -> str:
    raw = str(value or "").strip()
    if raw in BGA_OBJECT_CLASSES:
        return raw
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
    if "monitor" in text or "bildschirm" in text:
        return "Monitor"
    if any(term in text for term in ["laptop", "notebook", "pc", "computer", "thinkpad", "elitebook", "probook", "macbook"]):
        return "Laptop/PC"
    if "drucker" in text:
        return "Drucker"
    if "scanner" in text:
        return "Scanner"
    if "telefon" in text or "dect" in text:
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
        haystack = " ".join(
            str(row.get(key) or "")
            for key in ["object_class_name", "object_type", "brand", "model", "serial_number", "notes"]
        )
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
            "notes": row.get("notes"),
        }
        for _, row in scored[:limit]
    ]


def build_ai_suggestion(item_id: str) -> dict[str, Any]:
    fallback = build_stub_suggestion(item_id)
    try:
        return build_ollama_suggestion(item_id, fallback)
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

    oc = fetch_one("SELECT id FROM object_classes WHERE slug = %s", (object_class,))
    if oc:
        execute(
            """
            UPDATE inventory_items
            SET object_type = %s, object_class_id = %s, brand = COALESCE(%s, brand),
                commercial_category = %s, requires_accounting_review = %s,
                review_status = %s, status = 'ki_fertig', confidence_score = %s,
                age_source = %s, age_verification_status = %s, estimated_age_years = %s,
                updated_at = now()
            WHERE id = %s
            RETURNING id
            """,
            (
                result["object_type"],
                oc["id"],
                result.get("brand"),
                result["commercial_category"],
                result["requires_accounting_review"],
                result["recommended_status"],
                result["confidence"],
                result["age_source"],
                result["age_verification_status"],
                result.get("estimated_age_years"),
                item_id,
            ),
        )
    return result


def build_ollama_suggestion(item_id: str, fallback: dict[str, Any]) -> dict[str, Any]:
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
    if not has_object_photo:
        fallback["notes"] = "KI-Vorschlag übersprungen: kein Objektfoto vorhanden."
        fallback["_model_used"] = "not-started-no-object-photo"
        return fallback
    special_tool_matches = select_special_tool_references(transcripts, item.get("object_class_name"), limit=25)
    inventory_history_matches = select_inventory_history_references(transcripts, item.get("object_class_name"), limit=15)
    learning_examples = select_learning_examples(transcripts, item.get("object_class_name"), item.get("object_type"), limit=8)
    images = []
    for photo in photos:
        path = photo.get("original_path")
        if not path:
            continue
        try:
            with open(path, "rb") as handle:
                images.append(base64.b64encode(handle.read()).decode("ascii"))
        except OSError:
            continue

    prompt = {
        "task": "Analysiere ein einzelnes Inventarobjekt der Betriebs- und Geschäftsausstattung. Antworte ausschließlich als JSON.",
        "primary_goal": "Erkenne zuerst das sichtbare Hauptobjekt im Objektfoto. Trenne es sauber von Hintergrundobjekten wie Monitoren, Tastaturen, Kabeln, Laptops oder Tischflächen.",
        "object_class_hint": item.get("object_class_name"),
        "object_class_slug": item.get("object_class_slug"),
        "condition_hint": item.get("condition"),
        "inventory_id": item.get("inventory_id"),
        "photo_types": photo_types,
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
            "Wenn keine Klasse sicher passt, nutze object_class='Unklar', object_name='vermutlich ...', confidence unter 0.75 und requires_manual_review=true.",
            "Für eindeutige Objekte setze eine konkrete Bezeichnung, z. B. object_name='Computermaus' und object_class='Computermaus'.",
            "Computermaus: handgroßes Zeigegerät mit linker/rechter Taste, Scrollrad, Gehäuse zum Greifen, oft Kabel/USB/Funk. Eine Computermaus darf nicht als Monitor, Tastatur oder Notebook klassifiziert werden, nur weil solche Dinge im Hintergrund sichtbar sind.",
            "Tastatur: viele Tasten in einem Raster. Monitor: einzelner Bildschirm mit Displayfläche. Notebook/Laptop: Bildschirm und Tastatur fest zusammen in einem aufklappbaren Gerät.",
            "Wenn mehrere Gegenstände im Bild sind, bewerte das zentrale, am nächsten fotografierte oder per Sprache beschriebene Objekt als Hauptobjekt.",
            "Nutze object_front/object-Fotos für die Objektart, type_plate/nameplate-Fotos nur für Hersteller, Modell, Seriennummer und Baujahr. Detailfotos dürfen die Objektart stützen, aber nicht gegen das Hauptfoto übersteuern.",
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
                "construction_year": "string|null",
                "remark": "string|null",
            },
            "requires_manual_review": "boolean",
            "manufacturer": "string|null",
            "specification": "string|null",
            "visible_features": ["string"],
            "condition_guess": "neu|sehr_gut|gut|gebraucht|reparaturbeduerftig|defekt|aussondern|null",
            "suggested_remark": "string|null",
            "estimated_age_years": "number|null",
            "estimated_value_eur": "number|null",
            "estimated_value_confidence": "number|null",
            "estimated_value_reason": "string|null",
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
    payload = {
        "model": settings.ollama_model,
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
    with httpx.Client(timeout=settings.ollama_timeout_seconds) as client:
        response = client.post(f"{settings.ollama_url.rstrip('/')}/api/chat", json=payload)
        response.raise_for_status()
    content = response.json().get("message", {}).get("content", "{}")
    parsed = normalize_ollama_result(parse_ollama_json(content), fallback)
    result = {**fallback, **{key: value for key, value in parsed.items() if value is not None}}
    quick_it = classify_it_peripheral(" ".join(transcripts), str(result.get("object_type") or ""))
    if quick_it:
        _, update = quick_it
        result.update(update)
    if special_tool_matches:
        result["special_tool_matches"] = special_tool_matches[:5]
    if inventory_history_matches:
        result["inventory_history_matches"] = inventory_history_matches[:5]
    if learning_examples:
        result["learning_examples"] = learning_examples[:5]
    result["_model_used"] = settings.ollama_model
    result["notes"] = result.get("notes") or f"Ollama-Auswertung mit {settings.ollama_model}"
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
    object_name = result.get("object_name")
    manufacturer = result.get("manufacturer")
    specification = result.get("specification")
    condition_guess = result.get("condition_guess")
    requires_manual_review = result.get("requires_manual_review")
    if object_name and not result.get("object_type"):
        result["object_type"] = object_name
    if manufacturer and not result.get("brand"):
        result["brand"] = manufacturer
    if specification and not result.get("model"):
        result["model"] = specification
    if condition_guess and not result.get("condition"):
        result["condition"] = condition_guess
    if requires_manual_review is not None:
        result["requires_review"] = bool(requires_manual_review)
    normalized_object_class = normalize_bga_object_class(result.get("object_class"), result.get("object_name") or result.get("object_type"))
    result["object_class"] = normalized_object_class
    if normalized_object_class == "Unklar":
        if result.get("object_name") and not str(result.get("object_name")).lower().startswith("vermutlich"):
            result["object_name"] = f"vermutlich {result['object_name']}"
            result["object_type"] = result["object_name"]
        result["requires_manual_review"] = True
        result["requires_review"] = True
        if not result.get("uncertainty_reason"):
            result["uncertainty_reason"] = "Objektklasse nicht eindeutig aus der festen BGA-Klassenliste ableitbar."
        try:
            confidence = float(result.get("confidence") or 0)
        except (TypeError, ValueError):
            confidence = 0
        result["confidence"] = confidence if 0 < confidence < 0.75 else 0.6
    suggested_fields = result.get("suggested_fields")
    if not isinstance(suggested_fields, dict):
        suggested_fields = {}
    result["suggested_fields"] = {
        "object_type": suggested_fields.get("object_type") or result.get("object_name") or result.get("object_type"),
        "specification": suggested_fields.get("specification") or result.get("specification"),
        "condition": suggested_fields.get("condition") or result.get("condition_guess") or result.get("condition"),
        "construction_year": suggested_fields.get("construction_year") or result.get("construction_year"),
        "remark": suggested_fields.get("remark") or result.get("suggested_remark"),
    }
    result["bga_detection"] = {
        "object_name": result.get("object_name") or result.get("object_type"),
        "object_class": result.get("object_class"),
        "manufacturer": result.get("manufacturer") or result.get("brand"),
        "model": result.get("model"),
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
        "it_ausstattung",
        "betriebsmittel",
        "werkstattausstattung",
        "gwg_pruefen",
    }:
        result["requires_accounting_review"] = True
    credible_age_sources = {
        "typenschild",
        "baujahr",
        "modelljahr",
        "sichtbare_angabe",
        "seriennummer",
        "beleg",
        "dot",
    }
    age_source = str(result.get("age_source") or "").lower().strip()
    age_status = str(result.get("age_verification_status") or "").lower().strip()
    if result.get("estimated_age_years") is not None and (
        age_source not in credible_age_sources or age_status in {"geschaetzt", "nicht_ermittelbar", "offen", ""}
    ):
        result["estimated_age_years"] = None
        result["age_source"] = "unbekannt"
        result["age_verification_status"] = "offen"
        result["age_requires_review"] = True
    value_source = str(result.get("value_source") or "").lower().strip()
    if result.get("estimated_value_eur") is not None and value_source not in {
        "webrecherche",
        "sichtbare_preisangabe",
        "beleg",
        "referenzpreis",
        "modellpreis",
    }:
        result["estimated_value_eur"] = None
        result["value_requires_review"] = True
    if isinstance(result.get("bga_detection"), dict):
        result["bga_detection"]["estimated_age_years"] = result.get("estimated_age_years")
        result["bga_detection"]["estimated_value_eur"] = result.get("estimated_value_eur")
        result["bga_detection"]["condition_guess"] = result.get("condition")
        result["bga_detection"]["age_requires_review"] = bool(result.get("age_requires_review", True))
        result["bga_detection"]["value_requires_review"] = bool(result.get("value_requires_review", True))
    return result


def apply_suggestion_to_item(item_id: str, result: dict[str, Any], default_slug: str) -> None:
    object_class_text = str(result.get("object_class") or "").lower()
    object_type_text = str(result.get("object_type") or "").lower()
    object_class = default_slug
    if "reifen" in object_class_text or "reifen" in object_type_text:
        object_class = "reifen"
    elif "hebeb" in object_class_text or "bühne" in object_class_text or "hebeb" in object_type_text:
        object_class = "hebebuehne"
    elif "wucht" in object_class_text or "wucht" in object_type_text:
        object_class = "wuchtmaschine"
    elif "reifenmontier" in object_class_text or "montiermaschine" in object_type_text:
        object_class = "reifenmontiermaschine"
    elif "diagnose" in object_class_text or "diagnose" in object_type_text or "tester" in object_type_text:
        object_class = "diagnosegeraet"
    elif "kompressor" in object_class_text or "kompressor" in object_type_text or "druckluft" in object_type_text:
        object_class = "kompressor"
    elif any(term in object_class_text or term in object_type_text for term in ["eingabegerät", "eingabegeraet", "maus", "mouse", "tastatur", "keyboard", "trackpad"]):
        object_class = "eingabegeraet"
    elif any(term in object_class_text or term in object_type_text for term in ["notebook", "laptop", "thinkpad", "elitebook", "probook", "macbook"]):
        object_class = "notebook"
    elif "it" in object_class_text and "gerät" in object_class_text:
        object_class = "it_geraet"
    elif "werkzeugwagen" in object_class_text:
        object_class = "werkzeugwagen"
    elif "monitor" in object_class_text or "monitor" in object_type_text:
        object_class = "monitor"

    oc = fetch_one("SELECT id FROM object_classes WHERE slug = %s", (object_class,))
    if not oc:
        return
    age_source = result.get("age_source") or "unbekannt"
    age_verification_status = result.get("age_verification_status") or "offen"
    estimated_age_years = result.get("estimated_age_years")
    if age_source in {"schaetzung", "unbekannt"} or age_verification_status in {"geschaetzt", "nicht_ermittelbar"}:
        age_source = "unbekannt"
        age_verification_status = "offen"
        estimated_age_years = None
    execute(
        """
        UPDATE inventory_items
        SET object_type = %s, object_class_id = %s, brand = COALESCE(%s, brand),
            model = COALESCE(%s, model), serial_number = COALESCE(%s, serial_number),
            commercial_category = %s, requires_accounting_review = %s,
            review_status = %s, status = 'ki_fertig', confidence_score = %s,
            age_source = %s, age_verification_status = %s, estimated_age_years = %s,
            updated_at = now()
        WHERE id = %s
        RETURNING id
        """,
        (
            result.get("object_type") or "Unbekanntes Objekt",
            oc["id"],
            result.get("brand"),
            result.get("model"),
            result.get("serial_number"),
            result.get("commercial_category") or "ungeklaert",
            bool(result.get("requires_accounting_review")),
            result.get("recommended_status") or "pruefen",
            result.get("confidence") or 0,
            age_source,
            age_verification_status,
            estimated_age_years,
            item_id,
        ),
    )


def create_rework_tasks(item_id: str, suggestion: dict[str, Any]) -> None:
    photos = fetch_all("SELECT photo_type FROM item_photos WHERE item_id = %s", (item_id,))
    photo_types = {photo["photo_type"] for photo in photos}
    for field in suggestion.get("missing_fields", []):
        if field == "Typenschildfoto" and "nameplate" in photo_types:
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
        if missing_field:
            blockers.append(f"Offene Nacharbeit: {missing_field}")
    return blockers

