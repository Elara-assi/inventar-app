from __future__ import annotations

import hashlib
import os
import secrets
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from openpyxl import Workbook
from openpyxl.drawing.image import Image as ExcelImage
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter
from pydantic import BaseModel

from .db import execute, fetch_all, fetch_one
from .logic import (
    WORKSHOP_REFERENCE_CATALOG,
    audit,
    build_ai_suggestion,
    create_rework_tasks,
    finalization_blockers,
    load_inventory_history_references,
    load_special_tool_references,
    next_inventory_id,
    tokenize_reference_text,
)
from .settings import settings

app = FastAPI(title="Inventar API", version="0.1.0-phase1")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class LoginIn(BaseModel):
    email: str
    password: str = "demo"


class SessionIn(BaseModel):
    location_id: str | None = None
    location_name: str | None = None
    building_id: str | None = None
    building_name: str | None = None
    room_id: str | None = None
    room_name: str | None = None
    started_by: str | None = None


class JoinIn(BaseModel):
    token: str
    device_name: str = "Mobile device"
    device_fingerprint: str | None = None


class LocationIn(BaseModel):
    name: str
    code: str | None = None
    address: str | None = None


class UserIn(BaseModel):
    display_name: str
    email: str | None = None
    role_slug: str = "erfasser"


class RoomIn(BaseModel):
    building_id: str | None = None
    location_id: str | None = None
    location_name: str | None = None
    building_name: str | None = None
    name: str
    code: str | None = None
    room_type: str = "workspace"


class RoomPatch(BaseModel):
    building_id: str | None = None
    name: str | None = None
    code: str | None = None
    room_type: str | None = None


class ItemIn(BaseModel):
    session_id: str
    object_type: str | None = None
    object_class_id: str | None = None
    inventory_id: str | None = None
    temporary_id: str | None = None
    condition: str = "gebraucht"
    condition_note: str | None = None
    brand: str | None = None
    model: str | None = None
    serial_number: str | None = None
    created_by: str | None = None


class ItemPatch(BaseModel):
    object_type: str | None = None
    object_class_id: str | None = None
    brand: str | None = None
    model: str | None = None
    serial_number: str | None = None
    condition: str | None = None
    condition_note: str | None = None
    value_estimate: float | None = None
    status: str | None = None
    review_status: str | None = None
    commercial_category: str | None = None
    accounting_status: str | None = None


def ensure_upload_dirs() -> None:
    for sub in ["originals", "stamped", "audio", "exports", "temp"]:
        Path(settings.upload_root, sub).mkdir(parents=True, exist_ok=True)


def safe_upload_path(value: str) -> Path:
    root = Path(settings.upload_root).resolve()
    path = Path(value).resolve()
    if root not in path.parents and path != root:
        raise HTTPException(status_code=403, detail="Uploadpfad nicht erlaubt")
    return path


def require_item_session_open(item_id: str) -> dict[str, Any]:
    row = fetch_one(
        """
        SELECT i.id, i.session_id, s.status AS session_status
        FROM inventory_items i
        JOIN inventory_sessions s ON s.id = i.session_id
        WHERE i.id = %s
        """,
        (item_id,),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Item not found")
    if row["session_status"] != "open":
        raise HTTPException(status_code=409, detail="Raum ist abgeschlossen")
    return row


def build_process_hints(row: dict[str, Any], ai_result: dict[str, Any], tasks: list[dict[str, Any]]) -> list[dict[str, str]]:
    hints: list[dict[str, str]] = []
    seen: set[str] = set()

    def add(kind: str, label: str, severity: str = "info") -> None:
        if kind in seen:
            return
        seen.add(kind)
        hints.append({"kind": kind, "label": label, "severity": severity})

    status = row.get("status")
    if status in {"ki_wartet", "ki_laeuft", "ki_schnell_wartet", "ki_schnell_laeuft"}:
        add("ki", "KI läuft", "info")
    if status == "ki_schnell_fertig":
        add("ki_quick_done", "Schnell-KI fertig", "ok")
    if status == "ki_pruefung_offen":
        add("ki_review_open", "Prüf-KI offen", "warn")
    if status in {"ki_pruefung_wartet", "ki_pruefung_laeuft"}:
        add("ki_review", "Prüf-KI läuft", "info")
    if status == "ki_pruefung_fertig":
        add("ki_review_done", "Prüf-KI fertig", "ok")
    if row.get("confidence_score") and float(row["confidence_score"]) >= 0.7:
        add("ki_confident", "KI sicher", "ok")

    special_matches = ai_result.get("special_tool_matches") or []
    history_matches = ai_result.get("inventory_history_matches") or []
    if special_matches:
        add("reference", "Referenztreffer", "info")
    if history_matches:
        add("history", "Historie", "warn")

    for match in history_matches:
        if match.get("uvv_due"):
            add("uvv", "UVV prüfen", "danger")
        if match.get("maintenance_due"):
            add("maintenance", "Wartung prüfen", "warn")
        if match.get("inspection_book_missing"):
            add("inspection_book", "Prüfbuch fehlt", "warn")
        if match.get("missing"):
            add("target_missing", "Soll/Fehlt prüfen", "danger")
        if match.get("defective"):
            add("defective", "Defekt prüfen", "danger")

    for task in tasks:
        role = task.get("assigned_role")
        if role == "Technik":
            add("technical_rework", "Technik-Nacharbeit", "warn")
        elif role == "Buchhaltung":
            add("accounting_rework", "Buchhaltung", "info")
        elif role == "Erfasser":
            add("capture_rework", "Erfasser-Nacharbeit", "warn")

    return hints


@app.on_event("startup")
def startup() -> None:
    ensure_upload_dirs()


@app.get("/health")
def health() -> dict[str, Any]:
    db_ok = False
    try:
        db_ok = bool(fetch_one("SELECT 1 AS ok"))
    except Exception:
        db_ok = False
    return {"ok": True, "database": db_ok, "phase": "0+1"}


def resolve_location(location_id: str | None, location_name: str | None) -> dict[str, Any]:
    name = location_name.strip() if location_name else None
    if name:
        location = fetch_one("SELECT * FROM locations WHERE lower(name) = lower(%s)", (name,))
        if not location:
            location = execute(
                """
                INSERT INTO locations (name, code)
                VALUES (%s, %s)
                RETURNING *
                """,
                (name, f"BETR-{secrets.token_hex(2).upper()}"),
            )
            audit("location_created", "location", str(location["id"]), location)
        return location
    if location_id:
        location = fetch_one("SELECT * FROM locations WHERE id = %s", (location_id,))
        if location:
            return location
    location = fetch_one("SELECT * FROM locations ORDER BY created_at LIMIT 1")
    if location:
        return location
    location = execute(
        """
        INSERT INTO locations (name, code)
        VALUES ('Betrieb', %s)
        RETURNING *
        """,
        (f"LOC-{secrets.token_hex(2).upper()}",),
    )
    audit("location_created", "location", str(location["id"]), location)
    return location


@app.post("/auth/login")
def login(body: LoginIn) -> dict[str, Any]:
    user = fetch_one(
        """
        SELECT u.*, array_remove(array_agg(r.slug), null) AS roles
        FROM users u
        LEFT JOIN user_roles ur ON ur.user_id = u.id
        LEFT JOIN roles r ON r.id = ur.role_id
        WHERE u.email = %s AND u.active = true
        GROUP BY u.id
        """,
        (body.email,),
    )
    if not user:
        raise HTTPException(status_code=401, detail="Invalid demo login")
    audit("login", "user", str(user["id"]), {"email": body.email})
    return {"access_token": f"demo-{user['id']}", "user": user}


@app.get("/auth/me")
def me() -> dict[str, Any]:
    user = fetch_one("SELECT * FROM users WHERE email = %s", (settings.demo_user_email,))
    return {"user": user}


@app.get("/meta/bootstrap")
def bootstrap() -> dict[str, Any]:
    return {
        "users": fetch_all(
            """
            SELECT u.id, u.email, u.display_name, array_remove(array_agg(r.slug), null) AS roles
            FROM users u
            LEFT JOIN user_roles ur ON ur.user_id = u.id
            LEFT JOIN roles r ON r.id = ur.role_id
            WHERE u.active = true
            GROUP BY u.id
            ORDER BY u.display_name
            """
        ),
        "locations": fetch_all("SELECT * FROM locations ORDER BY name"),
        "buildings": fetch_all("SELECT * FROM buildings ORDER BY name"),
        "rooms": fetch_all("SELECT * FROM rooms ORDER BY name"),
        "object_classes": fetch_all("SELECT * FROM object_classes ORDER BY name"),
    }


def template_from_object_class(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": f"class:{row['id']}",
        "source": "Objektklasse",
        "label": row["name"],
        "subtitle": row.get("description") or "Standard-Vorlage",
        "object_type": row["name"],
        "object_class_id": str(row["id"]),
        "object_class_slug": row.get("slug"),
        "brand": None,
        "model": None,
    }


@app.get("/item-templates")
def item_templates(q: str = "", room: str = "", limit: int = 8) -> list[dict[str, Any]]:
    limit = max(1, min(limit, 12))
    query = " ".join([q, room]).strip()
    query_tokens = tokenize_reference_text(query)
    object_classes = fetch_all("SELECT * FROM object_classes ORDER BY name")
    class_by_slug = {row.get("slug"): row for row in object_classes}
    templates: list[dict[str, Any]] = [template_from_object_class(row) for row in object_classes]

    for entry in WORKSHOP_REFERENCE_CATALOG:
        oc = class_by_slug.get(entry.get("slug"))
        templates.append(
            {
                "id": f"workshop:{entry.get('slug')}",
                "source": "Werkstattprofil",
                "label": entry.get("object_class"),
                "subtitle": ", ".join((entry.get("typical_brands") or [])[:4]),
                "object_type": entry.get("object_class"),
                "object_class_id": str(oc["id"]) if oc else None,
                "object_class_slug": entry.get("slug"),
                "brand": None,
                "model": None,
            }
        )

    for record in load_special_tool_references()[:600]:
        label = record.get("designation_de") or record.get("designation_en") or record.get("vag_no") or record.get("order_no")
        if not label:
            continue
        templates.append(
            {
                "id": f"special:{record.get('row_id') or record.get('vag_no') or record.get('order_no')}",
                "source": "Spezialwerkzeug",
                "label": label,
                "subtitle": " · ".join(str(value) for value in [record.get("vag_no"), record.get("order_no"), record.get("source_file")] if value),
                "object_type": label,
                "object_class_id": None,
                "object_class_slug": None,
                "brand": None,
                "model": record.get("vag_no") or record.get("order_no"),
            }
        )

    for record in load_inventory_history_references()[:400]:
        label = record.get("designation_de") or record.get("tool_no")
        if not label:
            continue
        templates.append(
            {
                "id": f"history:{record.get('row_id') or record.get('tool_no')}",
                "source": "Alte Aufnahme",
                "label": label,
                "subtitle": " · ".join(str(value) for value in [record.get("tool_no"), record.get("action"), record.get("list_name")] if value),
                "object_type": label,
                "object_class_id": None,
                "object_class_slug": None,
                "brand": None,
                "model": record.get("tool_no"),
            }
        )

    seen: set[str] = set()
    scored: list[tuple[int, dict[str, Any]]] = []
    for template in templates:
        key = "|".join(str(template.get(field) or "").lower() for field in ["label", "subtitle", "source"])
        if key in seen:
            continue
        seen.add(key)
        haystack = " ".join(str(template.get(field) or "") for field in ["label", "subtitle", "source", "object_class_slug"])
        tokens = tokenize_reference_text(haystack)
        if query_tokens:
            score = len(query_tokens & tokens)
            if str(template.get("label") or "").lower().startswith(q.lower().strip()):
                score += 4
            if score <= 0:
                continue
        else:
            score = 1 if template["source"] in {"Objektklasse", "Werkstattprofil"} else 0
            if score <= 0:
                continue
        scored.append((score, template))
    scored.sort(key=lambda item: (item[0], item[1].get("source") == "Objektklasse"), reverse=True)
    return [template for _, template in scored[:limit]]


@app.post("/users")
def create_user(body: UserIn) -> dict[str, Any]:
    name = body.display_name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name fehlt")
    email = (body.email or f"{name.lower().replace(' ', '.')}@example.local").strip().lower()
    existing = fetch_one("SELECT * FROM users WHERE lower(email) = lower(%s)", (email,))
    if existing:
        return existing
    user = execute(
        """
        INSERT INTO users (email, display_name, password_hash)
        VALUES (%s, %s, 'demo')
        RETURNING *
        """,
        (email, name),
    )
    role = fetch_one("SELECT id FROM roles WHERE slug = %s", (body.role_slug,))
    if role:
        execute(
            "INSERT INTO user_roles (user_id, role_id) VALUES (%s, %s) ON CONFLICT DO NOTHING RETURNING user_id",
            (user["id"], role["id"]),
        )
    audit("user_created", "user", str(user["id"]), {"email": email, "role_slug": body.role_slug})
    return user


@app.post("/locations")
def create_location(body: LocationIn) -> dict[str, Any]:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Betriebsname fehlt")
    existing = fetch_one("SELECT * FROM locations WHERE lower(name) = lower(%s)", (name,))
    if existing:
        return existing
    code = (body.code or f"BETR-{secrets.token_hex(2).upper()}").strip().upper()
    row = execute(
        """
        INSERT INTO locations (name, code, address)
        VALUES (%s, %s, %s)
        RETURNING *
        """,
        (name, code, body.address),
    )
    audit("location_created", "location", str(row["id"]), row)
    return row


@app.post("/rooms")
def create_room(body: RoomIn) -> dict[str, Any]:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Raumname fehlt")
    building_id = body.building_id
    building_name = body.building_name.strip() if body.building_name else None
    if building_name:
        location = resolve_location(body.location_id, body.location_name)
        building = fetch_one(
            "SELECT * FROM buildings WHERE location_id = %s AND lower(name) = lower(%s)",
            (location["id"], building_name),
        )
        if not building:
            building = execute(
                """
                INSERT INTO buildings (location_id, name, code)
                VALUES (%s, %s, %s)
                RETURNING *
                """,
                (location["id"], building_name, f"GEB-{secrets.token_hex(3).upper()}"),
            )
            audit("building_created", "building", str(building["id"]), building)
        building_id = str(building["id"])
    if not building_id or not fetch_one("SELECT id FROM buildings WHERE id = %s", (building_id,)):
        raise HTTPException(status_code=400, detail="Gebäude auswählen oder neues Gebäude eingeben")
    code = (body.code or f"RAUM-{secrets.token_hex(3).upper()}").strip()
    row = execute(
        """
        INSERT INTO rooms (building_id, name, code, room_type)
        VALUES (%s, %s, %s, %s)
        RETURNING *
        """,
        (building_id, name, code, body.room_type),
    )
    audit("room_created", "room", str(row["id"]), row)
    return row


@app.patch("/rooms/{room_id}")
def update_room(room_id: str, body: RoomPatch) -> dict[str, Any]:
    current = fetch_one("SELECT * FROM rooms WHERE id = %s", (room_id,))
    if not current:
        raise HTTPException(status_code=404, detail="Raum nicht gefunden")
    building_id = body.building_id if body.building_id is not None else current["building_id"]
    if not fetch_one("SELECT id FROM buildings WHERE id = %s", (building_id,)):
        raise HTTPException(status_code=400, detail="Gebäude nicht gefunden")
    name = body.name.strip() if body.name is not None else current["name"]
    code = body.code.strip() if body.code is not None else current["code"]
    room_type = body.room_type.strip() if body.room_type is not None else current["room_type"]
    if not name:
        raise HTTPException(status_code=400, detail="Raumname fehlt")
    row = execute(
        """
        UPDATE rooms
        SET building_id = %s, name = %s, code = %s, room_type = %s
        WHERE id = %s
        RETURNING *
        """,
        (building_id, name, code, room_type, room_id),
    )
    audit("room_changed", "room", room_id, {"building_id": building_id, "name": name, "code": code, "room_type": room_type})
    return row


@app.delete("/rooms/{room_id}")
def delete_room(room_id: str, force: bool = False) -> dict[str, Any]:
    current = fetch_one("SELECT * FROM rooms WHERE id = %s", (room_id,))
    if not current:
        raise HTTPException(status_code=404, detail="Raum nicht gefunden")
    usage = fetch_one(
        """
        SELECT
          (SELECT count(*) FROM inventory_sessions WHERE room_id = %s) AS session_count,
          (SELECT count(*) FROM inventory_items WHERE room_id = %s) AS item_count
        """,
        (room_id, room_id),
    )
    has_usage = bool(usage and (usage["session_count"] or usage["item_count"]))
    if has_usage and not force:
        raise HTTPException(
            status_code=409,
            detail="Raum enthält noch Sessions oder Gegenstände. Nutze Löschen mit Bestätigung, um Testdaten mit zu entfernen.",
        )
    if has_usage:
        audit("room_delete_cascade_requested", "room", room_id, {"room": current, "usage": usage})
        execute("DELETE FROM inventory_sessions WHERE room_id = %s RETURNING id", (room_id,))
    row = execute("DELETE FROM rooms WHERE id = %s RETURNING *", (room_id,))
    audit("room_deleted", "room", room_id, {"room": row, "deleted_dependents": usage if has_usage else None})
    return {"deleted": True, "room": row, "deleted_dependents": usage if has_usage else None}


@app.post("/sessions")
def create_session(body: SessionIn) -> dict[str, Any]:
    token = secrets.token_urlsafe(18)
    room_id = body.room_id
    building_id = body.building_id
    location_id = body.location_id
    location_name = body.location_name.strip() if body.location_name else None
    building_name = body.building_name.strip() if body.building_name else None

    if body.room_name and not room_id:
        room_name = body.room_name.strip()
        if not room_name:
            raise HTTPException(status_code=400, detail="Raumname fehlt")
        if building_name:
            location = resolve_location(location_id, location_name)
            location_id = str(location["id"])
            building = fetch_one(
                "SELECT * FROM buildings WHERE location_id = %s AND lower(name) = lower(%s)",
                (location_id, building_name),
            )
            if not building:
                building = execute(
                    """
                    INSERT INTO buildings (location_id, name, code)
                    VALUES (%s, %s, %s)
                    RETURNING *
                    """,
                    (location_id, building_name, f"FREI-{secrets.token_hex(3).upper()}"),
                )
                audit("building_created", "building", str(building["id"]), building)
            building_id = str(building["id"])
        elif not building_id:
            location = resolve_location(location_id, location_name)
            location_id = str(location["id"])
            building = fetch_one("SELECT * FROM buildings WHERE location_id = %s ORDER BY created_at LIMIT 1", (location_id,))
            if not building:
                building = execute(
                    """
                    INSERT INTO buildings (location_id, name, code)
                    VALUES (%s, 'Hauptgebäude', %s)
                    RETURNING *
                    """,
                    (location["id"], f"HG-{secrets.token_hex(2).upper()}"),
                )
                audit("building_created", "building", str(building["id"]), building)
            building_id = str(building["id"])
        else:
            building = fetch_one("SELECT * FROM buildings WHERE id = %s", (building_id,))
            if not building:
                raise HTTPException(status_code=400, detail="Gebäude nicht gefunden")
        location_id = location_id or str(building["location_id"])
        room = fetch_one(
            "SELECT * FROM rooms WHERE building_id = %s AND lower(name) = lower(%s)",
            (building_id, room_name),
        )
        if not room:
            room = execute(
                """
                INSERT INTO rooms (building_id, name, code, room_type)
                VALUES (%s, %s, %s, 'workspace')
                RETURNING *
                """,
                (building_id, room_name, f"FREI-{secrets.token_hex(3).upper()}"),
            )
            audit("room_created", "room", str(room["id"]), room)
        room_id = str(room["id"])

    if not room_id:
        raise HTTPException(status_code=400, detail="Raum auswählen oder freien Raum eingeben")

    room = fetch_one(
        """
        SELECT r.*, b.location_id
        FROM rooms r
        JOIN buildings b ON b.id = r.building_id
        WHERE r.id = %s
        """,
        (room_id,),
    )
    if not room:
        raise HTTPException(status_code=400, detail="Raum nicht gefunden")
    building_id = str(room["building_id"])
    location_id = str(room["location_id"])

    row = execute(
        """
        INSERT INTO inventory_sessions (location_id, building_id, room_id, join_token, started_by)
        VALUES (%s, %s, %s, %s, %s)
        RETURNING *
        """,
        (location_id, building_id, room_id, token, body.started_by),
    )
    audit("session_started", "inventory_session", str(row["id"]), row)
    return row


@app.get("/sessions")
def list_sessions() -> list[dict[str, Any]]:
    return fetch_all(
        """
        SELECT s.*, l.name AS location_name, b.name AS building_name, r.name AS room_name,
          count(i.id)::int AS item_count
        FROM inventory_sessions s
        JOIN locations l ON l.id = s.location_id
        JOIN buildings b ON b.id = s.building_id
        JOIN rooms r ON r.id = s.room_id
        LEFT JOIN inventory_items i ON i.session_id = s.id
        GROUP BY s.id, l.name, b.name, r.name
        ORDER BY s.created_at DESC
        """
    )


@app.get("/sessions/{session_id}")
def get_session(session_id: str) -> dict[str, Any]:
    row = fetch_one(
        """
        SELECT s.*, l.name AS location_name, l.code AS location_code, b.name AS building_name, r.name AS room_name
        FROM inventory_sessions s
        JOIN locations l ON l.id = s.location_id
        JOIN buildings b ON b.id = s.building_id
        JOIN rooms r ON r.id = s.room_id
        WHERE s.id = %s
        """,
        (session_id,),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    return row


@app.post("/sessions/{session_id}/join-token")
def renew_join_token(session_id: str) -> dict[str, Any]:
    token = secrets.token_urlsafe(18)
    row = execute(
        "UPDATE inventory_sessions SET join_token = %s, join_token_expires_at = now() + interval '12 hours' WHERE id = %s RETURNING *",
        (token, session_id),
    )
    audit("join_token_created", "inventory_session", session_id, {"join_token": token})
    return row


@app.post("/sessions/join")
def join_session(body: JoinIn) -> dict[str, Any]:
    session = fetch_one(
        "SELECT * FROM inventory_sessions WHERE join_token = %s AND join_token_expires_at > now() AND status = 'open'",
        (body.token,),
    )
    if not session:
        raise HTTPException(status_code=404, detail="Join token invalid or expired")
    device = execute(
        """
        INSERT INTO session_devices (session_id, device_name, device_fingerprint)
        VALUES (%s, %s, %s)
        RETURNING *
        """,
        (session["id"], body.device_name, body.device_fingerprint),
    )
    audit("device_joined", "session_device", str(device["id"]), device)
    return {"session": session, "device": device}


@app.post("/sessions/{session_id}/close")
def close_session(session_id: str) -> dict[str, Any]:
    items = fetch_all("SELECT id FROM inventory_items WHERE session_id = %s", (session_id,))
    blockers = {str(i["id"]): finalization_blockers(str(i["id"])) for i in items}
    open_blockers = {k: v for k, v in blockers.items() if v}
    if open_blockers:
        raise HTTPException(status_code=409, detail={"message": "Offene blockierende Pflichtpunkte", "blockers": open_blockers})
    row = execute(
        "UPDATE inventory_sessions SET status = 'closed', closed_at = now() WHERE id = %s RETURNING *",
        (session_id,),
    )
    execute(
        "UPDATE inventory_items SET locked_at = COALESCE(locked_at, now()), updated_at = now() WHERE session_id = %s RETURNING id",
        (session_id,),
    )
    audit("session_closed", "inventory_session", session_id, row)
    return row


@app.delete("/sessions/{session_id}")
def delete_session(session_id: str) -> dict[str, Any]:
    current = fetch_one("SELECT * FROM inventory_sessions WHERE id = %s", (session_id,))
    if not current:
        raise HTTPException(status_code=404, detail="Session nicht gefunden")
    item_count = fetch_one("SELECT count(*)::int AS count FROM inventory_items WHERE session_id = %s", (session_id,))
    audit("session_deleted", "inventory_session", session_id, {"session": current, "item_count": item_count["count"] if item_count else 0})
    row = execute("DELETE FROM inventory_sessions WHERE id = %s RETURNING *", (session_id,))
    return {"deleted": True, "session": row}


@app.get("/sessions/{session_id}/devices")
def devices(session_id: str) -> list[dict[str, Any]]:
    return fetch_all("SELECT * FROM session_devices WHERE session_id = %s ORDER BY created_at DESC", (session_id,))


@app.post("/sessions/{session_id}/devices/{device_id}/revoke")
def revoke_device(session_id: str, device_id: str) -> dict[str, Any]:
    row = execute(
        "UPDATE session_devices SET revoked_at = now() WHERE id = %s AND session_id = %s RETURNING *",
        (device_id, session_id),
    )
    audit("device_revoked", "session_device", device_id, row)
    return row


@app.post("/items")
def create_item(body: ItemIn) -> dict[str, Any]:
    session = get_session(body.session_id)
    if session["status"] != "open":
        raise HTTPException(status_code=409, detail="Raum ist abgeschlossen")
    inventory_id = body.inventory_id or next_inventory_id(session["location_code"])
    temporary_id = body.temporary_id or f"TEMP-{secrets.token_hex(4).upper()}"
    oc = fetch_one("SELECT * FROM object_classes WHERE id = %s", (body.object_class_id,)) if body.object_class_id else None
    row = execute(
        """
        INSERT INTO inventory_items (
          inventory_id, temporary_id, session_id, location_id, building_id, room_id,
          object_type, object_class_id, brand, model, serial_number, condition,
          condition_note, commercial_category, requires_accounting_review,
          accounting_relevance, created_by
        )
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        RETURNING *
        """,
        (
            inventory_id,
            temporary_id,
            body.session_id,
            session["location_id"],
            session["building_id"],
            session["room_id"],
            body.object_type,
            body.object_class_id,
            body.brand,
            body.model,
            body.serial_number,
            body.condition,
            body.condition_note,
            oc["default_commercial_category"] if oc else "ungeklaert",
            oc["requires_accounting_review"] if oc else False,
            oc["requires_accounting_review"] if oc else False,
            body.created_by,
        ),
    )
    execute(
        """
        INSERT INTO item_accounting_data (item_id, commercial_category, accounting_status)
        VALUES (%s, %s, %s)
        RETURNING id
        """,
        (row["id"], row["commercial_category"], row["accounting_status"]),
    )
    audit("item_created", "inventory_item", str(row["id"]), row)
    return row


@app.get("/sessions/{session_id}/items")
def session_items(session_id: str) -> list[dict[str, Any]]:
    rows = fetch_all(
        """
        SELECT i.*, oc.name AS object_class_name,
          EXISTS(SELECT 1 FROM item_photos p WHERE p.item_id = i.id AND p.photo_type = 'object') AS has_object_photo,
          EXISTS(SELECT 1 FROM item_photos p WHERE p.item_id = i.id AND p.photo_type = 'nameplate') AS has_nameplate_photo,
          EXISTS(SELECT 1 FROM item_photos p WHERE p.item_id = i.id AND p.photo_type = 'dot') AS has_dot_photo,
          (
            SELECT p.id
            FROM item_photos p
            WHERE p.item_id = i.id AND p.photo_type = 'object'
            ORDER BY p.uploaded_at DESC
            LIMIT 1
          ) AS object_photo_id
        FROM inventory_items i
        LEFT JOIN object_classes oc ON oc.id = i.object_class_id
        WHERE i.session_id = %s
        ORDER BY i.created_at DESC
        """,
        (session_id,),
    )
    for row in rows:
        row["blockers"] = finalization_blockers(str(row["id"]))
        row["open_tasks"] = fetch_all(
            "SELECT * FROM accounting_tasks WHERE item_id = %s AND status = 'open' ORDER BY created_at",
            (row["id"],),
        )
        ai_row = fetch_one(
            "SELECT result_json FROM ai_results WHERE item_id = %s ORDER BY created_at DESC LIMIT 1",
            (row["id"],),
        )
        ai_result = ai_row.get("result_json") if ai_row else {}
        row["ai_summary"] = {
            "confidence": ai_result.get("confidence"),
            "notes": ai_result.get("notes"),
            "special_tool_matches": (ai_result.get("special_tool_matches") or [])[:3],
            "inventory_history_matches": (ai_result.get("inventory_history_matches") or [])[:3],
        }
        row["process_hints"] = build_process_hints(row, ai_result, row["open_tasks"])
    return rows


@app.get("/items/{item_id}")
def get_item(item_id: str) -> dict[str, Any]:
    row = fetch_one("SELECT * FROM inventory_items WHERE id = %s", (item_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Item not found")
    row["photos"] = fetch_all("SELECT * FROM item_photos WHERE item_id = %s ORDER BY uploaded_at", (item_id,))
    row["audio_notes"] = fetch_all("SELECT * FROM item_audio_notes WHERE item_id = %s ORDER BY uploaded_at", (item_id,))
    row["ai_results"] = fetch_all("SELECT * FROM ai_results WHERE item_id = %s ORDER BY created_at DESC", (item_id,))
    row["open_tasks"] = fetch_all(
        "SELECT * FROM accounting_tasks WHERE item_id = %s AND status = 'open' ORDER BY created_at",
        (item_id,),
    )
    row["accounting"] = fetch_one("SELECT * FROM item_accounting_data WHERE item_id = %s", (item_id,))
    row["blockers"] = finalization_blockers(item_id)
    return row


@app.patch("/items/{item_id}")
def patch_item(item_id: str, body: ItemPatch) -> dict[str, Any]:
    require_item_session_open(item_id)
    data = body.model_dump(exclude_unset=True)
    if not data:
        return get_item(item_id)
    allowed = list(data.keys())
    sql = ", ".join([f"{key} = %s" for key in allowed])
    row = execute(
        f"UPDATE inventory_items SET {sql}, updated_at = now() WHERE id = %s RETURNING *",
        tuple(data[key] for key in allowed) + (item_id,),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Item not found")
    audit("item_changed", "inventory_item", item_id, data)
    return row


@app.delete("/items/{item_id}")
def delete_item(item_id: str) -> dict[str, Any]:
    require_item_session_open(item_id)
    current = fetch_one("SELECT * FROM inventory_items WHERE id = %s", (item_id,))
    if not current:
        raise HTTPException(status_code=404, detail="Gegenstand nicht gefunden")
    audit("item_deleted", "inventory_item", item_id, current)
    row = execute("DELETE FROM inventory_items WHERE id = %s RETURNING *", (item_id,))
    return {"deleted": True, "item": row}


@app.post("/items/{item_id}/finalize")
def finalize_item(item_id: str) -> dict[str, Any]:
    require_item_session_open(item_id)
    blockers = finalization_blockers(item_id)
    if blockers:
        raise HTTPException(status_code=409, detail={"message": "Item has blockers", "blockers": blockers})
    row = execute(
        """
        UPDATE inventory_items
        SET review_status = 'finalisiert', status = 'finalisiert',
            lifecycle_status = COALESCE(lifecycle_status, 'aktiv'),
            finalized_at = now(), updated_at = now()
        WHERE id = %s RETURNING *
        """,
        (item_id,),
    )
    audit("item_finalized", "inventory_item", item_id, row)
    return row


@app.post("/items/{item_id}/request-rework")
def request_rework(item_id: str, body: dict[str, Any]) -> dict[str, Any]:
    require_item_session_open(item_id)
    assigned_role = body.get("assigned_role", "Prüfer")
    row = execute(
        """
        INSERT INTO accounting_tasks (item_id, task_type, assigned_role, missing_field, priority, comment)
        VALUES (%s, %s, %s, %s, %s, %s)
        RETURNING *
        """,
        (
            item_id,
            body.get("task_type", "rework"),
            assigned_role,
            body.get("missing_field"),
            body.get("priority", "normal"),
            body.get("comment"),
        ),
    )
    review_status = {
        "Buchhaltung": "nacharbeit_buchhaltung",
        "Erfasser": "nacharbeit_erfasser",
        "Technik": "nacharbeit_technik",
    }.get(assigned_role, "nacharbeit_pruefer")
    execute("UPDATE inventory_items SET review_status = %s WHERE id = %s RETURNING id", (review_status, item_id))
    audit("rework_requested", "inventory_item", item_id, row)
    return row


@app.post("/items/{item_id}/change-status")
def change_status(item_id: str, body: dict[str, Any]) -> dict[str, Any]:
    require_item_session_open(item_id)
    row = execute(
        "UPDATE inventory_items SET status = %s, review_status = COALESCE(%s, review_status), updated_at = now() WHERE id = %s RETURNING *",
        (body.get("status"), body.get("review_status"), item_id),
    )
    audit("status_changed", "inventory_item", item_id, body)
    return row


@app.post("/items/{item_id}/photos")
async def upload_photo(item_id: str, photo_type: str = "object", file: UploadFile = File(...)) -> dict[str, Any]:
    ensure_upload_dirs()
    require_item_session_open(item_id)
    data = await file.read()
    digest = hashlib.sha256(data).hexdigest()
    suffix = Path(file.filename or "upload.bin").suffix or ".bin"
    filename = f"{item_id}-{photo_type}-{digest[:12]}{suffix}"
    path = Path(settings.upload_root, "originals", filename)
    path.write_bytes(data)
    stamped = Path(settings.upload_root, "stamped", filename)
    stamped.write_bytes(data)
    row = execute(
        """
        INSERT INTO item_photos (item_id, photo_type, original_path, stamped_path, original_hash, metadata_json)
        VALUES (%s, %s, %s, %s, %s, %s::jsonb)
        RETURNING *
        """,
        (item_id, photo_type, str(path), str(stamped), digest, '{"phase":"1","stamp":"pending-worker"}'),
    )
    audit("photo_uploaded", "inventory_item", item_id, row)
    return row


@app.post("/items/{item_id}/audio")
async def upload_audio(item_id: str, transcript: str | None = None, file: UploadFile | None = File(None)) -> dict[str, Any]:
    ensure_upload_dirs()
    require_item_session_open(item_id)
    path = Path(settings.upload_root, "audio", f"{item_id}-{secrets.token_hex(4)}.txt")
    if file:
        data = await file.read()
        path = Path(settings.upload_root, "audio", f"{item_id}-{file.filename}")
        path.write_bytes(data)
    else:
        path.write_text(transcript or "", encoding="utf-8")
    row = execute(
        """
        INSERT INTO item_audio_notes (item_id, audio_path, transcript, transcript_status)
        VALUES (%s, %s, %s, 'completed')
        RETURNING *
        """,
        (item_id, str(path), transcript),
    )
    audit("audio_saved", "inventory_item", item_id, row)
    return row


def ai_status_for_mode(mode: str, step: str) -> str:
    normalized = "review" if mode == "review" else "fast"
    matrix = {
        "fast": {
            "queued": "ki_schnell_wartet",
            "running": "ki_schnell_laeuft",
            "done": "ki_schnell_fertig",
            "open": "ki_pruefung_offen",
        },
        "review": {
            "queued": "ki_pruefung_wartet",
            "running": "ki_pruefung_laeuft",
            "done": "ki_pruefung_fertig",
            "open": "ki_pruefung_offen",
        },
    }
    return matrix[normalized][step]


def process_ai_item(item_id: str, mode: str = "fast") -> None:
    normalized_mode = "review" if mode == "review" else "fast"
    execute(
        "UPDATE inventory_items SET status = %s, updated_at = now() WHERE id = %s RETURNING id",
        (ai_status_for_mode(normalized_mode, "running"), item_id),
    )
    suggestion = build_ai_suggestion(item_id)
    model_used = suggestion.pop("_model_used", "phase1-stub")
    confidence = float(suggestion.get("confidence") or 0)
    needs_review_ai = normalized_mode == "fast" and (
        confidence < 0.78
        or bool(suggestion.get("missing_fields"))
        or bool(suggestion.get("required_evidence_missing"))
    )
    suggestion["ai_stage"] = normalized_mode
    suggestion["needs_review_ai"] = needs_review_ai
    row = execute(
        """
        INSERT INTO ai_results (item_id, ai_type, model_used, prompt_version, input_sources, result_json, confidence)
        VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s)
        RETURNING *
        """,
        (
            item_id,
            "quick_vision" if normalized_mode == "fast" else "review_vision",
            model_used,
            "phase1-fast-v1" if normalized_mode == "fast" else "phase1-review-v1",
            '["photos","audio"]',
            json_string(suggestion),
            confidence,
        ),
    )
    create_rework_tasks(item_id, suggestion)
    execute(
        """
        UPDATE item_accounting_data
        SET commercial_category = %s,
            accounting_status = CASE WHEN %s THEN 'buchhaltung_pruefen' ELSE 'nicht_relevant' END
        WHERE item_id = %s
        RETURNING id
        """,
        (suggestion["commercial_category"], suggestion["requires_accounting_review"], item_id),
    )
    final_status = ai_status_for_mode(normalized_mode, "open" if needs_review_ai else "done")
    execute(
        "UPDATE inventory_items SET status = %s, updated_at = now() WHERE id = %s RETURNING id",
        (final_status, item_id),
    )
    audit("ai_result_created", "inventory_item", item_id, {"stage": normalized_mode, "status": final_status, **suggestion})


@app.post("/items/{item_id}/ai/run")
def run_ai(item_id: str, background_tasks: BackgroundTasks, mode: str = "fast") -> dict[str, Any]:
    require_item_session_open(item_id)
    normalized_mode = "review" if mode == "review" else "fast"
    queued_status = ai_status_for_mode(normalized_mode, "queued")
    execute("UPDATE inventory_items SET status = %s, updated_at = now() WHERE id = %s RETURNING id", (queued_status, item_id))
    background_tasks.add_task(process_ai_item, item_id, normalized_mode)
    audit("ai_job_queued", "inventory_item", item_id, {"status": queued_status, "stage": normalized_mode})
    label = "Prüf-KI" if normalized_mode == "review" else "Schnell-KI"
    return {"item_id": item_id, "status": queued_status, "stage": normalized_mode, "message": f"{label} läuft im Hintergrund"}

@app.post("/sessions/{session_id}/ai/review")
def run_session_review_ai(session_id: str, background_tasks: BackgroundTasks) -> dict[str, Any]:
    session = fetch_one("SELECT id, status FROM inventory_sessions WHERE id = %s", (session_id,))
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session["status"] != "open":
        raise HTTPException(status_code=409, detail="Raum ist abgeschlossen")

    rows = fetch_all(
        """
        SELECT id
        FROM inventory_items
        WHERE session_id = %s
          AND finalized_at IS NULL
          AND locked_at IS NULL
          AND status NOT IN ('ki_pruefung_wartet', 'ki_pruefung_laeuft', 'finalisiert')
        ORDER BY created_at
        """,
        (session_id,),
    )
    for row in rows:
        item_id = str(row["id"])
        execute(
            "UPDATE inventory_items SET status = %s, updated_at = now() WHERE id = %s RETURNING id",
            (ai_status_for_mode("review", "queued"), item_id),
        )
        background_tasks.add_task(process_ai_item, item_id, "review")
    audit("session_ai_review_queued", "inventory_session", session_id, {"queued": len(rows)})
    return {"session_id": session_id, "queued": len(rows), "status": "ki_pruefung_wartet"}


def json_string(value: Any) -> str:
    import json

    return json.dumps(value, default=str)


def excel_value(value: Any) -> Any:
    if isinstance(value, datetime) and value.tzinfo is not None:
        return value.replace(tzinfo=None)
    return value


def filename_part(value: str | None, fallback: str) -> str:
    raw = (value or fallback).strip().lower()
    cleaned = "".join(ch if ch.isalnum() else "-" for ch in raw)
    while "--" in cleaned:
        cleaned = cleaned.replace("--", "-")
    return cleaned.strip("-") or fallback


EXPORT_COLUMNS = [
    ("Foto", "photo_cell"),
    ("Betrieb", "location_name"),
    ("Gebäude", "building_name"),
    ("Raum", "room_name"),
    ("Session-Status", "session_status"),
    ("Session-Start", "session_created_at"),
    ("Inventar-ID", "inventory_id"),
    ("Temporäre ID", "temporary_id"),
    ("Objektart", "object_type"),
    ("Objektklasse", "object_class_name"),
    ("Kategorie", "category"),
    ("Marke", "brand"),
    ("Modell", "model"),
    ("Seriennummer", "serial_number"),
    ("Zustand", "condition"),
    ("Bemerkung", "condition_note"),
    ("Schätzwert", "value_estimate"),
    ("Altersquelle", "age_source"),
    ("Altersprüfung", "age_verification_status"),
    ("Geschätztes Alter", "estimated_age_years"),
    ("Herstellungsdatum", "manufacturing_date"),
    ("Anschaffungsdatum", "acquisition_date"),
    ("Inbetriebnahme", "commissioning_date"),
    ("Kostenstelle", "cost_center"),
    ("Kaufmännische Kategorie", "commercial_category"),
    ("Buchhaltungsrelevanz", "accounting_relevance"),
    ("Buchhaltungsstatus", "accounting_status"),
    ("Buchhaltung prüfen", "requires_accounting_review"),
    ("Status", "status"),
    ("Bearbeitung", "review_status"),
    ("Lebenszyklus", "lifecycle_status"),
    ("KI-Konfidenz", "confidence_score"),
    ("Objektfoto", "has_object_photo"),
    ("Typenschildfoto", "has_nameplate_photo"),
    ("DOT-Foto", "has_dot_photo"),
    ("Weitere Fotos", "photo_count"),
    ("Sprachnotizen", "audio_count"),
    ("Offene Nacharbeiten", "open_task_count"),
    ("Nacharbeit Rollen", "open_task_roles"),
    ("Nacharbeit Felder", "open_task_fields"),
    ("Erfasst von", "created_by_name"),
    ("Geprüft von", "reviewed_by_name"),
    ("Finalisiert von", "finalized_by_name"),
    ("Erfasst am", "created_at"),
    ("Aktualisiert am", "updated_at"),
    ("Finalisiert am", "finalized_at"),
]


def export_query(where_sql: str = "", params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    return fetch_all(
        f"""
        SELECT i.*, oc.name AS object_class_name,
          s.status AS session_status, s.created_at AS session_created_at,
          l.name AS location_name, b.name AS building_name, r.name AS room_name,
          creator.display_name AS created_by_name,
          reviewer.display_name AS reviewed_by_name,
          finalizer.display_name AS finalized_by_name,
          EXISTS(SELECT 1 FROM item_photos p WHERE p.item_id = i.id AND p.photo_type = 'object') AS has_object_photo,
          EXISTS(SELECT 1 FROM item_photos p WHERE p.item_id = i.id AND p.photo_type = 'nameplate') AS has_nameplate_photo,
          EXISTS(SELECT 1 FROM item_photos p WHERE p.item_id = i.id AND p.photo_type = 'dot') AS has_dot_photo,
          (
            SELECT p.id
            FROM item_photos p
            WHERE p.item_id = i.id AND p.photo_type = 'object'
            ORDER BY p.uploaded_at DESC
            LIMIT 1
          ) AS object_photo_id,
          (
            SELECT COALESCE(p.stamped_path, p.original_path)
            FROM item_photos p
            WHERE p.item_id = i.id AND p.photo_type = 'object'
            ORDER BY p.uploaded_at DESC
            LIMIT 1
          ) AS object_photo_path,
          (SELECT count(*)::int FROM item_photos p WHERE p.item_id = i.id) AS photo_count,
          (SELECT count(*)::int FROM item_audio_notes a WHERE a.item_id = i.id) AS audio_count,
          (SELECT count(*)::int FROM accounting_tasks t WHERE t.item_id = i.id AND t.status = 'open') AS open_task_count,
          (
            SELECT string_agg(DISTINCT t.assigned_role, ', ' ORDER BY t.assigned_role)
            FROM accounting_tasks t
            WHERE t.item_id = i.id AND t.status = 'open'
          ) AS open_task_roles,
          (
            SELECT string_agg(t.missing_field, ', ' ORDER BY t.created_at)
            FROM accounting_tasks t
            WHERE t.item_id = i.id AND t.status = 'open'
          ) AS open_task_fields
        FROM inventory_items i
        JOIN inventory_sessions s ON s.id = i.session_id
        JOIN locations l ON l.id = i.location_id
        JOIN buildings b ON b.id = i.building_id
        JOIN rooms r ON r.id = i.room_id
        LEFT JOIN object_classes oc ON oc.id = i.object_class_id
        LEFT JOIN users creator ON creator.id = i.created_by
        LEFT JOIN users reviewer ON reviewer.id = i.reviewed_by
        LEFT JOIN users finalizer ON finalizer.id = i.finalized_by
        {where_sql}
        ORDER BY l.name, b.name, r.name, i.created_at DESC
        """,
        params,
    )


def build_excel_workbook(title: str, rows: list[dict[str, Any]], summary: dict[str, Any]) -> Workbook:
    wb = Workbook()
    ws = wb.active
    ws.title = "Inventur"
    ws.append([header for header, _ in EXPORT_COLUMNS])
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="20343D")

    for row_index, row in enumerate(rows, start=2):
        ws.append([excel_value(row.get(key)) for _, key in EXPORT_COLUMNS])
        insert_excel_photo(ws, row, row_index)

    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions
    for index, (header, key) in enumerate(EXPORT_COLUMNS, start=1):
        max_length = len(header)
        for row in rows[:200]:
            max_length = max(max_length, len(str(row.get(key) or "")))
        ws.column_dimensions[get_column_letter(index)].width = 16 if key == "photo_cell" else min(max(max_length + 2, 12), 42)

    summary_ws = wb.create_sheet("Übersicht", 0)
    summary_ws.append(["Export", title])
    summary_ws.append(["Erzeugt am", excel_value(datetime.now())])
    for key, value in summary.items():
        summary_ws.append([key, excel_value(value)])
    summary_ws["A1"].font = Font(bold=True)
    summary_ws["B1"].font = Font(bold=True)
    summary_ws.column_dimensions["A"].width = 24
    summary_ws.column_dimensions["B"].width = 42

    task_ws = wb.create_sheet("Nacharbeiten")
    task_ws.append(["Inventar-ID", "Objektart", "Rolle", "Feld / Thema", "Status", "Betrieb", "Gebäude", "Raum"])
    for row in rows:
        if not row.get("open_task_count"):
            continue
        task_ws.append([
            row.get("inventory_id"),
            row.get("object_type"),
            row.get("open_task_roles"),
            row.get("open_task_fields"),
            row.get("review_status"),
            row.get("location_name"),
            row.get("building_name"),
            row.get("room_name"),
        ])
    task_ws.freeze_panes = "A2"
    task_ws.auto_filter.ref = task_ws.dimensions
    for index in range(1, 9):
        task_ws.column_dimensions[get_column_letter(index)].width = 24

    return wb


def insert_excel_photo(ws: Any, row: dict[str, Any], row_index: int) -> None:
    photo_path = row.get("object_photo_path")
    if not photo_path:
        ws.cell(row=row_index, column=1, value="kein Foto")
        return
    path = Path(str(photo_path))
    if not path.exists():
        ws.cell(row=row_index, column=1, value="Foto fehlt")
        return
    try:
        image = ExcelImage(str(path))
    except Exception:
        ws.cell(row=row_index, column=1, value="Foto nicht lesbar")
        return

    max_side = 82
    scale = min(max_side / image.width, max_side / image.height, 1)
    image.width = int(image.width * scale)
    image.height = int(image.height * scale)
    image.anchor = f"A{row_index}"
    ws.add_image(image)
    ws.row_dimensions[row_index].height = 68
    cell = ws.cell(row=row_index, column=1)
    cell.value = " "
    if row.get("object_photo_id"):
        cell.hyperlink = f"/uploads/photos/{row['object_photo_id']}"
        cell.style = "Hyperlink"


def save_export(
    *,
    title: str,
    rows: list[dict[str, Any]],
    filename: str,
    session_id: str | None,
    entity_type: str,
    entity_id: str | None,
    export_type: str,
    summary: dict[str, Any],
) -> dict[str, Any]:
    ensure_upload_dirs()
    path = Path(settings.upload_root, "exports", filename)
    wb = build_excel_workbook(title, rows, summary)
    wb.save(path)
    export = execute(
        "INSERT INTO exports (session_id, export_type, file_path) VALUES (%s, %s, %s) RETURNING *",
        (session_id, export_type, str(path)),
    )
    audit("export_created", entity_type, entity_id, {"export": export, "rows": len(rows), "title": title})
    return export


@app.get("/items/{item_id}/ai-results")
def ai_results(item_id: str) -> list[dict[str, Any]]:
    return fetch_all("SELECT * FROM ai_results WHERE item_id = %s ORDER BY created_at DESC", (item_id,))


@app.get("/object-classes")
def object_classes() -> list[dict[str, Any]]:
    return fetch_all("SELECT * FROM object_classes ORDER BY name")


@app.get("/object-classes/{class_id}/requirements")
def requirements(class_id: str) -> list[dict[str, Any]]:
    return fetch_all("SELECT * FROM field_requirements WHERE object_class_id = %s ORDER BY sort_order", (class_id,))


@app.post("/object-classes")
def create_object_class(body: dict[str, Any]) -> dict[str, Any]:
    row = execute(
        """
        INSERT INTO object_classes (name, slug, description, default_commercial_category, requires_accounting_review)
        VALUES (%s, %s, %s, %s, %s) RETURNING *
        """,
        (
            body["name"],
            body["slug"],
            body.get("description"),
            body.get("default_commercial_category", "ungeklaert"),
            body.get("requires_accounting_review", False),
        ),
    )
    audit("object_class_created", "object_class", str(row["id"]), row)
    return row


@app.patch("/object-classes/{class_id}")
def update_object_class(class_id: str, body: dict[str, Any]) -> dict[str, Any]:
    row = execute(
        """
        UPDATE object_classes
        SET description = COALESCE(%s, description),
            default_commercial_category = COALESCE(%s, default_commercial_category),
            updated_at = now()
        WHERE id = %s RETURNING *
        """,
        (body.get("description"), body.get("default_commercial_category"), class_id),
    )
    return row


@app.get("/accounting/tasks")
def accounting_tasks() -> list[dict[str, Any]]:
    return fetch_all("SELECT * FROM accounting_tasks ORDER BY created_at DESC")


@app.patch("/accounting/tasks/{task_id}")
def patch_accounting_task(task_id: str, body: dict[str, Any]) -> dict[str, Any]:
    row = execute(
        """
        UPDATE accounting_tasks
        SET status = COALESCE(%s, status), comment = COALESCE(%s, comment),
            completed_at = CASE WHEN %s = 'completed' THEN now() ELSE completed_at END
        WHERE id = %s RETURNING *
        """,
        (body.get("status"), body.get("comment"), body.get("status"), task_id),
    )
    audit("accounting_task_changed", "accounting_task", task_id, row)
    return row


@app.get("/items/{item_id}/accounting")
def item_accounting(item_id: str) -> dict[str, Any]:
    return fetch_one("SELECT * FROM item_accounting_data WHERE item_id = %s", (item_id,))


@app.patch("/items/{item_id}/accounting")
def patch_item_accounting(item_id: str, body: dict[str, Any]) -> dict[str, Any]:
    require_item_session_open(item_id)
    row = execute(
        """
        UPDATE item_accounting_data
        SET commercial_category = COALESCE(%s, commercial_category),
            cost_center = COALESCE(%s, cost_center),
            asset_number = COALESCE(%s, asset_number),
            book_value = COALESCE(%s, book_value),
            accounting_status = COALESCE(%s, accounting_status)
        WHERE item_id = %s RETURNING *
        """,
        (
            body.get("commercial_category"),
            body.get("cost_center"),
            body.get("asset_number"),
            body.get("book_value"),
            body.get("accounting_status"),
            item_id,
        ),
    )
    audit("accounting_changed", "inventory_item", item_id, row)
    return row


@app.post("/sessions/{session_id}/export/excel")
def export_excel(session_id: str) -> dict[str, Any]:
    session = get_session(session_id)
    rows = export_query("WHERE i.session_id = %s", (session_id,))
    return save_export(
        title=f"Raumaufnahme {session.get('room_name') or session_id}",
        rows=rows,
        filename=f"raumaufnahme-{filename_part(session.get('room_name'), 'raum')}-{session_id[:8]}.xlsx",
        session_id=session_id,
        entity_type="inventory_session",
        entity_id=session_id,
        export_type="session_excel",
        summary={
            "Betrieb": session.get("location_name"),
            "Gebäude": session.get("building_name"),
            "Raum": session.get("room_name"),
            "Objekte": len(rows),
            "Offene Nacharbeiten": sum(int(row.get("open_task_count") or 0) for row in rows),
        },
    )
    ensure_upload_dirs()
    rows = session_items(session_id)
    wb = Workbook()
    ws = wb.active
    ws.title = "Inventur"
    headers = [
        "Inventar-ID", "temporäre ID", "Objektart", "Objektklasse", "Kategorie", "Marke",
        "Modell", "Seriennummer", "Zustand", "Altersquelle", "geschätztes Alter",
        "Herstellungsdatum", "Anschaffungsdatum", "Betrieb", "Gebäude", "Raum",
        "Verantwortlicher", "Kostenstelle", "kaufmännische Kategorie",
        "Buchhaltungsstatus", "Buchhaltung prüfen", "Status", "Prüfstatus",
        "KI-Konfidenz", "Foto vorhanden", "Typenschildfoto vorhanden", "DOT-Foto vorhanden",
        "Erfasst von", "Geprüft von", "Finalisiert am", "Bemerkung",
    ]
    ws.append(headers)
    session = get_session(session_id)
    for row in rows:
        ws.append([excel_value(value) for value in [
            row.get("inventory_id"), row.get("temporary_id"), row.get("object_type"),
            row.get("object_class_name"), row.get("category"), row.get("brand"),
            row.get("model"), row.get("serial_number"), row.get("condition"),
            row.get("age_source"), row.get("estimated_age_years"), row.get("manufacturing_date"),
            row.get("acquisition_date"), session.get("location_name"), session.get("building_name"),
            session.get("room_name"), None, row.get("cost_center"), row.get("commercial_category"),
            row.get("accounting_status"), row.get("requires_accounting_review"), row.get("status"),
            row.get("review_status"), row.get("confidence_score"), row.get("has_object_photo"),
            row.get("has_nameplate_photo"), row.get("has_dot_photo"), row.get("created_by"),
            row.get("reviewed_by"), row.get("finalized_at"), row.get("condition_note"),
        ]])
    path = Path(settings.upload_root, "exports", f"session-{session_id}.xlsx")
    wb.save(path)
    export = execute(
        "INSERT INTO exports (session_id, file_path) VALUES (%s, %s) RETURNING *",
        (session_id, str(path)),
    )
    audit("export_created", "inventory_session", session_id, export)
    return export


@app.post("/items/{item_id}/export/excel")
def export_item_excel(item_id: str) -> dict[str, Any]:
    item = get_item(item_id)
    rows = export_query("WHERE i.id = %s", (item_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="Gegenstand nicht gefunden")
    row = rows[0]
    label = row.get("inventory_id") or row.get("temporary_id") or item_id
    return save_export(
        title=f"Aufnahme {label}",
        rows=rows,
        filename=f"aufnahme-{filename_part(str(label), 'gegenstand')}.xlsx",
        session_id=str(item["session_id"]),
        entity_type="inventory_item",
        entity_id=item_id,
        export_type="item_excel",
        summary={
            "Inventar-ID": row.get("inventory_id"),
            "Objektart": row.get("object_type"),
            "Betrieb": row.get("location_name"),
            "Raum": row.get("room_name"),
            "Offene Nacharbeiten": row.get("open_task_count"),
        },
    )


@app.post("/exports/excel")
def export_all_excel() -> dict[str, Any]:
    rows = export_query()
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    locations = len({row.get("location_name") for row in rows if row.get("location_name")})
    rooms = len({(row.get("location_name"), row.get("building_name"), row.get("room_name")) for row in rows})
    return save_export(
        title="Gesamtaufstellung Inventur",
        rows=rows,
        filename=f"gesamtaufstellung-inventur-{timestamp}.xlsx",
        session_id=None,
        entity_type="inventory_export",
        entity_id=None,
        export_type="all_excel",
        summary={
            "Betriebe": locations,
            "Räume": rooms,
            "Objekte": len(rows),
            "Offene Nacharbeiten": sum(int(row.get("open_task_count") or 0) for row in rows),
            "Finalisiert": sum(1 for row in rows if row.get("review_status") == "finalisiert" or row.get("status") == "finalisiert"),
        },
    )


@app.get("/exports/{export_id}/download")
def download_export(export_id: str) -> FileResponse:
    row = fetch_one("SELECT * FROM exports WHERE id = %s", (export_id,))
    if not row or not os.path.exists(row["file_path"]):
        raise HTTPException(status_code=404, detail="Export not found")
    return FileResponse(row["file_path"], filename=Path(row["file_path"]).name)


@app.get("/uploads/photos/{photo_id}")
def download_photo(photo_id: str) -> FileResponse:
    row = fetch_one("SELECT * FROM item_photos WHERE id = %s", (photo_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Foto nicht gefunden")
    path = safe_upload_path(row.get("stamped_path") or row["original_path"])
    if not path.exists():
        raise HTTPException(status_code=404, detail="Fotodatei nicht gefunden")
    return FileResponse(path)


@app.get("/items/{item_id}/audit-log")
def item_audit(item_id: str) -> list[dict[str, Any]]:
    return fetch_all("SELECT * FROM audit_log WHERE entity_id = %s ORDER BY created_at DESC", (item_id,))


@app.get("/sessions/{session_id}/audit-log")
def session_audit(session_id: str) -> list[dict[str, Any]]:
    return fetch_all("SELECT * FROM audit_log WHERE entity_id = %s OR entity_type = 'inventory_item' ORDER BY created_at DESC LIMIT 200", (session_id,))


@app.get("/sessions/{session_id}/events")
async def session_events(session_id: str):
    async def stream():
        import asyncio
        import json

        last_payload = ""
        while True:
            payload = json.dumps({"items": session_items(session_id)}, default=str)
            if payload != last_payload:
                yield f"data: {payload}\n\n"
                last_payload = payload
            await asyncio.sleep(2)

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.get("/uploads/{file_id}")
def upload_placeholder(file_id: str) -> dict[str, str]:
    return {"message": "Phase 1 stores file paths internally. Signed file lookup is reserved for hardening.", "file_id": file_id}
