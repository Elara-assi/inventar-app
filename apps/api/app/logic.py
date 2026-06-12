from __future__ import annotations

import json
import logging
import re
from datetime import date
from typing import Any

import psycopg

from .db import execute, fetch_all, fetch_one

log = logging.getLogger("inventar.logic")


def json_dumps(value: Any) -> str:
    return json.dumps(value if value is not None else {}, default=str)


def next_inventory_id(location_code: str, conn: psycopg.Connection) -> str:
    """Atomare ID-Vergabe ueber Zaehlertabelle.

    Ersetzt count(*)+1: Das erzeugte bei zwei parallel erfassenden Handys
    dieselbe Nummer und damit UNIQUE-Verletzungen (verlorene Objekte).
    Muss innerhalb der Item-Transaktion laufen, damit eine abgebrochene
    Anlage keine Luecke unnoetig gross macht und die Vergabe konsistent ist.
    """
    year = date.today().year
    row = execute(
        """
        INSERT INTO inventory_id_counters (location_code, year, counter)
        VALUES (%s, %s, 1)
        ON CONFLICT (location_code, year)
        DO UPDATE SET counter = inventory_id_counters.counter + 1
        RETURNING counter
        """,
        (location_code, year),
        conn=conn,
    )
    return f"SHR-{location_code}-{year}-{(row or {'counter': 1})['counter']:06d}"


def audit(action: str, entity_type: str, entity_id: str | None, new_value: Any = None, reason: str | None = None) -> None:
    """Best-effort-Audit: darf den fachlichen Request niemals abbrechen."""
    try:
        execute(
            """
            INSERT INTO audit_log (entity_type, entity_id, action, new_value_json, reason)
            VALUES (%s, %s, %s, %s::jsonb, %s)
            RETURNING id
            """,
            (entity_type, entity_id, action, json_dumps(new_value), reason),
        )
    except Exception:
        log.exception("Audit fehlgeschlagen: %s %s %s", action, entity_type, entity_id)


def compute_blockers(
    item: dict[str, Any],
    requirements: list[dict[str, Any]],
    photo_types: set[str],
    ai_result: dict[str, Any],
    open_task_fields: set[str],
) -> list[str]:
    """Pure Blocker-Berechnung ohne DB-Zugriff (gebatcht nutzbar)."""
    if not item.get("object_class_id"):
        return ["Objektklasse fehlt"]
    blockers: list[str] = []
    for row in requirements:
        field = row["field_name"]
        if field == "object_photo":
            if "object" not in photo_types:
                blockers.append(row["field_label"])
            continue
        if row.get("evidence_photo_type"):
            if row["evidence_photo_type"] not in photo_types:
                blockers.append(row["field_label"])
            continue
        if field in item:
            if item.get(field) in (None, ""):
                blockers.append(row["field_label"])
        elif not ai_result.get(field):
            blockers.append(row["field_label"])
    for missing_field in sorted(f for f in open_task_fields if f):
        blockers.append(f"Offene Nacharbeit: {missing_field}")
    return blockers


def load_blocker_context(item_ids: list[str]) -> dict[str, dict[str, Any]]:
    """Laedt Fotos, offene Tasks, Requirements und letztes KI-Resultat fuer
    viele Items in 4 Queries (vorher ~6 Queries pro Item, N+1)."""
    if not item_ids:
        return {}
    photos = fetch_all(
        "SELECT id, item_id, photo_type FROM item_photos WHERE item_id = ANY(%s) ORDER BY uploaded_at",
        (item_ids,),
    )
    tasks = fetch_all(
        """
        SELECT * FROM accounting_tasks
        WHERE item_id = ANY(%s) AND status = 'open'
        ORDER BY created_at
        """,
        (item_ids,),
    )
    ai_rows = fetch_all(
        """
        SELECT DISTINCT ON (item_id) item_id, result_json
        FROM ai_results
        WHERE item_id = ANY(%s) AND status = 'completed'
        ORDER BY item_id, created_at DESC
        """,
        (item_ids,),
    )
    requirements = fetch_all(
        """
        SELECT object_class_id, field_name, field_label, evidence_photo_type, sort_order
        FROM field_requirements
        WHERE required = true AND blocks_finalization = true
        ORDER BY sort_order
        """,
    )
    ctx: dict[str, dict[str, Any]] = {
        str(item_id): {"photos": [], "photo_types": set(), "open_tasks": [], "ai_result": {}}
        for item_id in item_ids
    }
    for p in photos:
        entry = ctx[str(p["item_id"])]
        entry["photos"].append({"id": str(p["id"]), "photo_type": p["photo_type"]})
        entry["photo_types"].add(p["photo_type"])
    for t in tasks:
        ctx[str(t["item_id"])]["open_tasks"].append(t)
    for a in ai_rows:
        ctx[str(a["item_id"])]["ai_result"] = a.get("result_json") or {}
    reqs_by_class: dict[str, list[dict[str, Any]]] = {}
    for r in requirements:
        reqs_by_class.setdefault(str(r["object_class_id"]), []).append(r)
    for entry in ctx.values():
        entry["reqs_by_class"] = reqs_by_class
    return ctx


def blockers_for_item(item: dict[str, Any], ctx_entry: dict[str, Any]) -> list[str]:
    reqs = ctx_entry["reqs_by_class"].get(str(item.get("object_class_id") or ""), [])
    open_fields = {t.get("missing_field") for t in ctx_entry["open_tasks"] if t.get("assigned_role") in ("Erfasser", "Technik")}
    return compute_blockers(item, reqs, ctx_entry["photo_types"], ctx_entry["ai_result"], open_fields)


def finalization_blockers(item_id: str) -> list[str]:
    """Einzelabruf (finalize, Detailansicht) auf Basis derselben Logik."""
    item = fetch_one("SELECT * FROM inventory_items WHERE id = %s", (item_id,))
    if not item:
        return ["Objekt nicht gefunden"]
    ctx = load_blocker_context([str(item_id)])
    return blockers_for_item(item, ctx[str(item_id)])


def build_ai_suggestion(item_id: str) -> dict[str, Any]:
    """Deterministischer Phase-1-Stub.

    Korrektur gegenueber Erststand: Eine vom Erfasser bewusst gewaehlte
    Objektklasse wird respektiert und nicht mehr pauschal mit "Monitor"
    ueberschrieben; nur eindeutige Text-Hinweise (Reifen/Hebebuehne)
    aendern die Klasse.
    """
    item = fetch_one(
        """
        SELECT i.*, oc.slug AS object_class_slug, oc.name AS object_class_name,
               oc.default_commercial_category, oc.requires_accounting_review AS oc_requires_accounting_review
        FROM inventory_items i
        LEFT JOIN object_classes oc ON oc.id = i.object_class_id
        WHERE i.id = %s
        """,
        (item_id,),
    ) or {}
    notes = fetch_all("SELECT transcript FROM item_audio_notes WHERE item_id = %s", (item_id,))
    text = " ".join([str(n.get("transcript") or "") for n in notes]).lower()

    existing_class_slug = item.get("object_class_slug")
    existing_class_name = item.get("object_class_name")
    object_class_slug = existing_class_slug or "monitor"
    result: dict[str, Any] = {
        "object_type": item.get("object_type") or existing_class_name or "Unbekanntes Objekt",
        "object_class": existing_class_name or "Monitor",
        "category": None,
        "brand": item.get("brand"),
        "model": item.get("model"),
        "serial_number": item.get("serial_number"),
        "condition": item.get("condition") or "gebraucht",
        "condition_note": item.get("condition_note"),
        "location_hint": None,
        "detected_inventory_id": item.get("inventory_id"),
        "manufacturing_date": None,
        "acquisition_date": None,
        "commissioning_date": None,
        "estimated_age_years": None,
        "age_source": "buchhaltung",
        "age_verification_status": "offen",
        "commercial_category": item.get("default_commercial_category") or "ungeklaert",
        "requires_accounting_review": bool(item.get("oc_requires_accounting_review", True)),
        "missing_fields": ["Seriennummer", "Anschaffungsdatum", "Buchwert"],
        "required_evidence_missing": [],
        "recommended_tasks": [{"role": "Buchhaltung", "task": "Anlagenummer, Anschaffungsdatum und Buchwert pruefen"}],
        "confidence": 0.62,
        "requires_review": True,
        "recommended_status": "nacharbeit_buchhaltung",
        "notes": "Phase-1 KI-Stub. LiteLLM/Vision wird ueber Worker angebunden.",
    }
    if item.get("serial_number"):
        result["missing_fields"] = [f for f in result["missing_fields"] if f != "Seriennummer"]

    if "reifen" in text or "dot" in text or "michelin" in text:
        dot = re.search(r"\b(\d{4})\b", text)
        dot_number = dot.group(1) if dot else None
        production_year = 2000 + int(dot_number[2:]) if dot_number else None
        result.update(
            {
                "object_type": "Reifensatz",
                "object_class": "Reifen",
                "brand": "Michelin" if "michelin" in text else result.get("brand"),
                "tire_size": None,
                "dot_number": dot_number,
                "production_week": int(dot_number[:2]) if dot_number else None,
                "production_year": production_year,
                "estimated_age_years": round(date.today().year - production_year, 1) if production_year else None,
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
        object_class_slug = "reifen"
    elif "hebeb" in text or "buehne" in text:
        result.update(
            {
                "object_type": "Hebebuehne",
                "object_class": "Hebebuehne",
                "brand": "Nussbaum" if "nussbaum" in text else result.get("brand"),
                "commercial_category": "anlagevermoegen",
                "requires_accounting_review": True,
                "missing_fields": ["Typenschildfoto", "Seriennummer", "Tragfaehigkeit"],
                "required_evidence_missing": ["nameplate"],
                "recommended_status": "nacharbeit_erfasser",
                "confidence": 0.69,
            }
        )
        object_class_slug = "hebebuehne"
    elif "dell" in text:
        result["brand"] = "Dell"
        if not existing_class_slug:
            result["object_type"] = "Monitor"

    oc = fetch_one("SELECT id, name FROM object_classes WHERE slug = %s", (object_class_slug,))
    if oc:
        result["object_class"] = oc["name"]
        execute(
            """
            UPDATE inventory_items
            SET object_type = %s, object_class_id = %s, brand = COALESCE(%s, brand),
                commercial_category = %s, requires_accounting_review = %s,
                review_status = %s, status = 'ki_fertig', confidence_score = %s,
                age_source = %s, age_verification_status = %s, estimated_age_years = %s,
                updated_at = now()
            WHERE id = %s AND locked_at IS NULL
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


def create_rework_tasks(item_id: str, suggestion: dict[str, Any]) -> None:
    photos = fetch_all("SELECT photo_type FROM item_photos WHERE item_id = %s", (item_id,))
    photo_types = {photo["photo_type"] for photo in photos}
    for field in suggestion.get("missing_fields", []):
        if field == "Typenschildfoto" and "nameplate" in photo_types:
            continue
        if field == "DOT-Foto" and "dot" in photo_types:
            continue
        if field in ["Anschaffungsdatum", "Buchwert", "Anlagenummer"]:
            role = "Buchhaltung"
        elif field in ["Profiltiefe", "DOT-Foto", "Typenschildfoto"]:
            role = "Erfasser"
        else:
            role = "Pruefer"
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
            (item_id, role, field, f"Nacharbeit aus KI/Pflichtfeldlogik: {field}", item_id, field),
        )
