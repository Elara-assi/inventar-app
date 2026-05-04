from __future__ import annotations

import re
from datetime import date
from typing import Any

from .db import execute, fetch_all, fetch_one


def next_inventory_id(location_code: str = "SIM") -> str:
    year = date.today().year
    prefix = f"SHR-{location_code}-{year}-"
    row = fetch_one(
        "SELECT count(*)::int AS count FROM inventory_items WHERE inventory_id LIKE %s",
        (prefix + "%",),
    )
    return f"{prefix}{(row or {'count': 0})['count'] + 1:06d}"


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


def build_ai_suggestion(item_id: str) -> dict[str, Any]:
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
    text = " ".join([str(n.get("transcript") or "") for n in notes]).lower()
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
        "recommended_tasks": [{"role": "Buchhaltung", "task": "Anlagenummer, Anschaffungsdatum und Buchwert prüfen"}],
        "confidence": 0.62,
        "requires_review": True,
        "recommended_status": "nacharbeit_buchhaltung",
        "notes": "Phase-1-Auswertung. LiteLLM/Vision wird über Worker angebunden.",
    }

    if object_class == "reifen" or "reifen" in text or "dot" in text or "michelin" in text:
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
    elif "dell" in text:
        result["brand"] = "Dell"
        result["object_type"] = "Monitor"

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
            (item_id, role, field, f"Nacharbeit aus KI/Pflichtfeldlogik: {field}", item_id, field),
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
            if "object" not in photo_types:
                blockers.append(row["field_label"])
            continue
        if row["evidence_photo_type"]:
            if row["evidence_photo_type"] not in photo_types:
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
