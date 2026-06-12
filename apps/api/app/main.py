from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import secrets
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from openpyxl import Workbook
from pydantic import BaseModel, Field, field_validator

from . import constants as C
from .db import close_pool, execute, fetch_all, fetch_one, get_pool, transaction
from .logic import (
    audit,
    blockers_for_item,
    build_ai_suggestion,
    create_rework_tasks,
    finalization_blockers,
    json_dumps,
    load_blocker_context,
    next_inventory_id,
)
from .settings import settings

log = logging.getLogger("inventar.api")
logging.basicConfig(level=logging.INFO)


def ensure_upload_dirs() -> None:
    for sub in ["originals", "stamped", "audio", "exports", "temp"]:
        Path(settings.upload_root, sub).mkdir(parents=True, exist_ok=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    ensure_upload_dirs()
    try:
        get_pool()
    except Exception:
        log.exception("DB-Pool konnte beim Start nicht geoeffnet werden (API laeuft weiter, health zeigt database:false)")
    yield
    close_pool()


app = FastAPI(title="Inventar API", version="0.2.0-phase1", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Eingabemodelle (vorher teils ungetypte dicts -> beliebige Werte in der DB)
# ---------------------------------------------------------------------------

class LoginIn(BaseModel):
    email: str
    password: str = "demo"


class SessionIn(BaseModel):
    location_id: str
    building_id: str
    room_id: str
    started_by: str | None = None


class JoinIn(BaseModel):
    token: str
    device_name: str = "Mobile device"
    device_fingerprint: str | None = None


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
    manufacturing_year: int | None = Field(default=None, ge=1900, le=2099)
    client_capture_id: str | None = None
    created_by: str | None = None

    @field_validator("client_capture_id")
    @classmethod
    def _capture_id(cls, v: str | None) -> str | None:
        if v is None:
            return v
        import uuid
        try:
            return str(uuid.UUID(v))
        except ValueError as exc:
            raise ValueError("client_capture_id muss eine UUID sein") from exc

    @field_validator("condition")
    @classmethod
    def _condition(cls, v: str) -> str:
        if v not in C.CONDITIONS:
            raise ValueError(f"Ungueltiger Zustand: {v}")
        return v


class ItemPatch(BaseModel):
    object_type: str | None = None
    object_class_id: str | None = None
    brand: str | None = None
    model: str | None = None
    serial_number: str | None = None
    condition: str | None = None
    condition_note: str | None = None
    status: str | None = None
    review_status: str | None = None
    commercial_category: str | None = None
    accounting_status: str | None = None

    @field_validator("condition")
    @classmethod
    def _condition(cls, v: str | None) -> str | None:
        if v is not None and v not in C.CONDITIONS:
            raise ValueError(f"Ungueltiger Zustand: {v}")
        return v

    @field_validator("status")
    @classmethod
    def _status(cls, v: str | None) -> str | None:
        if v is not None and v not in C.CAPTURE_STATUSES:
            raise ValueError(f"Ungueltiger Status: {v}")
        return v

    @field_validator("review_status")
    @classmethod
    def _review(cls, v: str | None) -> str | None:
        if v is not None and v not in C.REVIEW_STATUSES:
            raise ValueError(f"Ungueltiger Pruefstatus: {v}")
        return v

    @field_validator("commercial_category")
    @classmethod
    def _cc(cls, v: str | None) -> str | None:
        if v is not None and v not in C.COMMERCIAL_CATEGORIES:
            raise ValueError(f"Ungueltige kaufmaennische Kategorie: {v}")
        return v

    @field_validator("accounting_status")
    @classmethod
    def _acc(cls, v: str | None) -> str | None:
        if v is not None and v not in C.ACCOUNTING_STATUSES:
            raise ValueError(f"Ungueltiger Buchhaltungsstatus: {v}")
        return v


class ReworkIn(BaseModel):
    assigned_role: str = "Pruefer"
    task_type: str = "rework"
    missing_field: str | None = None
    priority: str = "normal"
    comment: str | None = None

    @field_validator("assigned_role")
    @classmethod
    def _role(cls, v: str) -> str:
        if v not in C.ASSIGNED_ROLES:
            raise ValueError(f"Ungueltige Rolle: {v}")
        return v


class StatusChangeIn(BaseModel):
    status: str
    review_status: str | None = None

    @field_validator("status")
    @classmethod
    def _status(cls, v: str) -> str:
        if v not in C.CAPTURE_STATUSES:
            raise ValueError(f"Ungueltiger Status: {v}")
        return v

    @field_validator("review_status")
    @classmethod
    def _review(cls, v: str | None) -> str | None:
        if v is not None and v not in C.REVIEW_STATUSES:
            raise ValueError(f"Ungueltiger Pruefstatus: {v}")
        return v


class AccountingPatch(BaseModel):
    commercial_category: str | None = None
    cost_center: str | None = None
    asset_number: str | None = None
    book_value: float | None = None
    accounting_status: str | None = None

    @field_validator("commercial_category")
    @classmethod
    def _cc(cls, v: str | None) -> str | None:
        if v is not None and v not in C.COMMERCIAL_CATEGORIES:
            raise ValueError(f"Ungueltige kaufmaennische Kategorie: {v}")
        return v

    @field_validator("accounting_status")
    @classmethod
    def _acc(cls, v: str | None) -> str | None:
        if v is not None and v not in C.ACCOUNTING_STATUSES:
            raise ValueError(f"Ungueltiger Buchhaltungsstatus: {v}")
        return v


class TaskPatch(BaseModel):
    status: str | None = None
    comment: str | None = None

    @field_validator("status")
    @classmethod
    def _status(cls, v: str | None) -> str | None:
        if v is not None and v not in C.TASK_STATUSES:
            raise ValueError(f"Ungueltiger Aufgabenstatus: {v}")
        return v


class ObjectClassIn(BaseModel):
    name: str
    slug: str
    description: str | None = None
    default_commercial_category: str = "ungeklaert"
    requires_accounting_review: bool = False

    @field_validator("default_commercial_category")
    @classmethod
    def _cc(cls, v: str) -> str:
        if v not in C.COMMERCIAL_CATEGORIES:
            raise ValueError(f"Ungueltige kaufmaennische Kategorie: {v}")
        return v


class ObjectClassPatch(BaseModel):
    description: str | None = None
    default_commercial_category: str | None = None

    @field_validator("default_commercial_category")
    @classmethod
    def _cc(cls, v: str | None) -> str | None:
        if v is not None and v not in C.COMMERCIAL_CATEGORIES:
            raise ValueError(f"Ungueltige kaufmaennische Kategorie: {v}")
        return v


# ---------------------------------------------------------------------------
# Health & Auth
# ---------------------------------------------------------------------------

@app.get("/health")
def health() -> dict[str, Any]:
    db_ok = False
    try:
        db_ok = bool(fetch_one("SELECT 1 AS ok"))
    except Exception:
        db_ok = False
    return {"ok": True, "database": db_ok, "phase": "0+1", "version": app.version}


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
        "locations": fetch_all("SELECT * FROM locations ORDER BY name"),
        "buildings": fetch_all("SELECT * FROM buildings ORDER BY name"),
        "rooms": fetch_all("SELECT * FROM rooms ORDER BY name"),
        "object_classes": fetch_all("SELECT * FROM object_classes ORDER BY name"),
        "brands": [row["name"] for row in fetch_all("SELECT name FROM brand_lexicon ORDER BY name")],
    }


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

@app.post("/sessions")
def create_session(body: SessionIn) -> dict[str, Any]:
    token = secrets.token_urlsafe(18)
    row = execute(
        """
        INSERT INTO inventory_sessions (location_id, building_id, room_id, join_token, started_by)
        VALUES (%s, %s, %s, %s, %s)
        RETURNING *
        """,
        (body.location_id, body.building_id, body.room_id, token, body.started_by),
    )
    audit("session_started", "inventory_session", str(row["id"]), row)
    return row


@app.get("/sessions")
def list_sessions() -> list[dict[str, Any]]:
    return fetch_all(
        """
        SELECT s.*, l.name AS location_name, b.name AS building_name, r.name AS room_name,
          (SELECT count(*) FROM inventory_items i WHERE i.session_id = s.id)::int AS item_count
        FROM inventory_sessions s
        JOIN locations l ON l.id = s.location_id
        JOIN buildings b ON b.id = s.building_id
        JOIN rooms r ON r.id = s.room_id
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
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
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


def _session_items_with_context(session_id: str) -> list[dict[str, Any]]:
    """Items + Fotos + Blocker + offene Aufgaben in 5 Queries (vorher 6N+1)."""
    rows = fetch_all(
        """
        SELECT i.*, oc.name AS object_class_name
        FROM inventory_items i
        LEFT JOIN object_classes oc ON oc.id = i.object_class_id
        WHERE i.session_id = %s
        ORDER BY i.created_at DESC
        """,
        (session_id,),
    )
    ctx = load_blocker_context([str(r["id"]) for r in rows])
    for row in rows:
        entry = ctx[str(row["id"])]
        row["photos"] = entry["photos"]
        row["has_object_photo"] = "object" in entry["photo_types"]
        row["has_nameplate_photo"] = "nameplate" in entry["photo_types"]
        row["has_dot_photo"] = "dot" in entry["photo_types"]
        row["open_tasks"] = entry["open_tasks"]
        row["blockers"] = blockers_for_item(row, entry)
    return rows


@app.get("/sessions/{session_id}/items")
def session_items(session_id: str) -> list[dict[str, Any]]:
    return _session_items_with_context(session_id)


@app.post("/sessions/{session_id}/close")
def close_session(session_id: str) -> dict[str, Any]:
    session = fetch_one("SELECT * FROM inventory_sessions WHERE id = %s", (session_id,))
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session["status"] == "closed":
        raise HTTPException(status_code=409, detail="Session ist bereits abgeschlossen")
    items = _session_items_with_context(session_id)
    open_blockers = {
        (item.get("inventory_id") or item.get("temporary_id") or str(item["id"])): item["blockers"]
        for item in items
        if item["blockers"]
    }
    if open_blockers:
        raise HTTPException(
            status_code=409,
            detail={"message": "Offene blockierende Pflichtpunkte", "blockers": open_blockers},
        )
    row = execute(
        "UPDATE inventory_sessions SET status = 'closed', closed_at = now() WHERE id = %s RETURNING *",
        (session_id,),
    )
    audit("session_closed", "inventory_session", session_id, row)
    return row


@app.post("/sessions/{session_id}/reopen")
def reopen_session(session_id: str) -> dict[str, Any]:
    """Pruefer oeffnet einen abgeschlossenen Raum wieder, damit Geraete mit
    lokal wartenden Erfassungen (Offline-Quarantaene) nachsyncen koennen."""
    session = fetch_one("SELECT * FROM inventory_sessions WHERE id = %s", (session_id,))
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session["status"] != "closed":
        raise HTTPException(status_code=409, detail="Session ist nicht abgeschlossen")
    row = execute(
        "UPDATE inventory_sessions SET status = 'open', closed_at = NULL, join_token_expires_at = now() + interval '12 hours' WHERE id = %s RETURNING *",
        (session_id,),
    )
    audit("session_reopened", "inventory_session", session_id, row)
    return row


class HeartbeatIn(BaseModel):
    pending_count: int = Field(default=0, ge=0)


@app.post("/sessions/{session_id}/devices/{device_id}/heartbeat")
def device_heartbeat(session_id: str, device_id: str, body: HeartbeatIn) -> dict[str, Any]:
    row = execute(
        "UPDATE session_devices SET last_seen_at = now(), pending_count = %s WHERE id = %s AND session_id = %s RETURNING *",
        (body.pending_count, device_id, session_id),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Device not found")
    return row


@app.get("/sessions/{session_id}/devices")
def devices(session_id: str) -> list[dict[str, Any]]:
    return fetch_all("SELECT * FROM session_devices WHERE session_id = %s ORDER BY created_at DESC", (session_id,))


@app.post("/sessions/{session_id}/devices/{device_id}/revoke")
def revoke_device(session_id: str, device_id: str) -> dict[str, Any]:
    row = execute(
        "UPDATE session_devices SET revoked_at = now() WHERE id = %s AND session_id = %s RETURNING *",
        (device_id, session_id),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Device not found")
    audit("device_revoked", "session_device", device_id, row)
    return row


# ---------------------------------------------------------------------------
# Items
# ---------------------------------------------------------------------------

@app.post("/items")
def create_item(body: ItemIn) -> dict[str, Any]:
    # Idempotenz fuer den Offline-Sync: Bricht das Netz nach dem Server-Commit,
    # aber vor der Client-Bestaetigung ab, liefert der Wiederholungsversuch das
    # bereits angelegte Objekt zurueck statt eine Dublette zu erzeugen.
    if body.client_capture_id:
        existing = fetch_one(
            "SELECT * FROM inventory_items WHERE client_capture_id = %s",
            (body.client_capture_id,),
        )
        if existing:
            return existing
    session = get_session(body.session_id)
    if session["status"] != "open":
        raise HTTPException(status_code=409, detail="Session ist abgeschlossen, keine Erfassung mehr moeglich")
    oc = None
    if body.object_class_id:
        oc = fetch_one("SELECT * FROM object_classes WHERE id = %s", (body.object_class_id,))
        if not oc:
            raise HTTPException(status_code=422, detail="Unbekannte Objektklasse")
    temporary_id = body.temporary_id or f"TEMP-{secrets.token_hex(4).upper()}"
    # Atomar: ID-Vergabe + Item + Buchhaltungsdatensatz in EINER Transaktion.
    # Vorher: Einzel-Commits -> halbfertige Items bei Fehlern, doppelte IDs
    # bei parallelen Erfassern.
    with transaction() as conn:
        inventory_id = body.inventory_id or next_inventory_id(session["location_code"], conn)
        row = execute(
            """
            INSERT INTO inventory_items (
              inventory_id, temporary_id, session_id, location_id, building_id, room_id,
              object_type, object_class_id, brand, model, serial_number, condition,
              condition_note, manufacturing_date, client_capture_id,
              commercial_category, requires_accounting_review,
              accounting_relevance, created_by
            )
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (client_capture_id) WHERE client_capture_id IS NOT NULL DO NOTHING
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
                f"{body.manufacturing_year}-01-01" if body.manufacturing_year else None,
                body.client_capture_id,
                oc["default_commercial_category"] if oc else "ungeklaert",
                oc["requires_accounting_review"] if oc else False,
                oc["requires_accounting_review"] if oc else False,
                body.created_by,
            ),
            conn=conn,
        )
        if row is None:
            # Paralleler Sync desselben Geraets hat gewonnen: bestehendes Item liefern.
            row = fetch_one(
                "SELECT * FROM inventory_items WHERE client_capture_id = %s",
                (body.client_capture_id,),
                conn=conn,
            )
            return row
        execute(
            """
            INSERT INTO item_accounting_data (item_id, commercial_category, accounting_status)
            VALUES (%s, %s, %s)
            RETURNING id
            """,
            (row["id"], row["commercial_category"], row["accounting_status"]),
            conn=conn,
        )
    audit("item_created", "inventory_item", str(row["id"]), row)
    return row


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


# Whitelist der per PATCH aenderbaren Spalten. Die Spaltennamen stammen aus
# dem Pydantic-Modell (nie aus dem Request), die Werte sind parametrisiert.
_PATCHABLE_COLUMNS = (
    "object_type", "object_class_id", "brand", "model", "serial_number",
    "condition", "condition_note", "status", "review_status",
    "commercial_category", "accounting_status",
)


@app.patch("/items/{item_id}")
def patch_item(item_id: str, body: ItemPatch) -> dict[str, Any]:
    data = body.model_dump(exclude_unset=True)
    if not data:
        return get_item(item_id)
    if data.get("object_class_id"):
        if not fetch_one("SELECT id FROM object_classes WHERE id = %s", (data["object_class_id"],)):
            raise HTTPException(status_code=422, detail="Unbekannte Objektklasse")
    columns = [key for key in _PATCHABLE_COLUMNS if key in data]
    sql = ", ".join([f"{key} = %s" for key in columns])
    row = execute(
        f"UPDATE inventory_items SET {sql}, updated_at = now() WHERE id = %s AND locked_at IS NULL RETURNING *",
        tuple(data[key] for key in columns) + (item_id,),
    )
    if not row:
        raise HTTPException(status_code=409, detail="Objekt ist finalisiert/gesperrt oder existiert nicht")
    audit("item_changed", "inventory_item", item_id, data)
    return row


@app.post("/items/{item_id}/finalize")
def finalize_item(item_id: str) -> dict[str, Any]:
    blockers = finalization_blockers(item_id)
    if blockers:
        raise HTTPException(status_code=409, detail={"message": "Item has blockers", "blockers": blockers})
    row = execute(
        """
        UPDATE inventory_items
        SET review_status = 'finalisiert', status = 'finalisiert',
            lifecycle_status = COALESCE(lifecycle_status, 'aktiv'),
            finalized_at = now(), locked_at = now(), updated_at = now()
        WHERE id = %s AND locked_at IS NULL RETURNING *
        """,
        (item_id,),
    )
    if not row:
        raise HTTPException(status_code=409, detail="Objekt ist bereits finalisiert oder existiert nicht")
    audit("item_finalized", "inventory_item", item_id, row)
    return row


@app.post("/items/{item_id}/request-rework")
def request_rework(item_id: str, body: ReworkIn) -> dict[str, Any]:
    if not fetch_one("SELECT id FROM inventory_items WHERE id = %s", (item_id,)):
        raise HTTPException(status_code=404, detail="Item not found")
    row = execute(
        """
        INSERT INTO accounting_tasks (item_id, task_type, assigned_role, missing_field, priority, comment)
        VALUES (%s, %s, %s, %s, %s, %s)
        RETURNING *
        """,
        (item_id, body.task_type, body.assigned_role, body.missing_field, body.priority, body.comment),
    )
    review_status = {
        "Buchhaltung": "nacharbeit_buchhaltung",
        "Erfasser": "nacharbeit_erfasser",
        "Technik": "nacharbeit_technik",
    }.get(body.assigned_role, "nacharbeit_pruefer")
    execute(
        "UPDATE inventory_items SET review_status = %s, updated_at = now() WHERE id = %s AND locked_at IS NULL RETURNING id",
        (review_status, item_id),
    )
    audit("rework_requested", "inventory_item", item_id, row)
    return row


@app.post("/items/{item_id}/change-status")
def change_status(item_id: str, body: StatusChangeIn) -> dict[str, Any]:
    row = execute(
        "UPDATE inventory_items SET status = %s, review_status = COALESCE(%s, review_status), updated_at = now() WHERE id = %s AND locked_at IS NULL RETURNING *",
        (body.status, body.review_status, item_id),
    )
    if not row:
        raise HTTPException(status_code=409, detail="Objekt ist finalisiert/gesperrt oder existiert nicht")
    audit("status_changed", "inventory_item", item_id, body.model_dump(exclude_unset=True))
    return row


# ---------------------------------------------------------------------------
# Uploads & Dateiauslieferung
# ---------------------------------------------------------------------------

def _validated_suffix(file: UploadFile, allowed_suffixes: set[str]) -> str:
    """Prueft die Dateiendung; der Client-Dateiname selbst wird nie verwendet."""
    suffix = Path(file.filename or "upload.bin").suffix.lower()
    if suffix not in allowed_suffixes:
        raise HTTPException(status_code=422, detail=f"Dateityp {suffix or 'unbekannt'} nicht erlaubt")
    return suffix


async def _read_limited(file: UploadFile) -> bytes:
    limit = settings.max_upload_mb * 1024 * 1024
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(status_code=413, detail=f"Datei groesser als {settings.max_upload_mb} MB")
    if not data:
        raise HTTPException(status_code=422, detail="Leere Datei")
    return data


@app.post("/items/{item_id}/photos")
async def upload_photo(item_id: str, photo_type: str = "object", file: UploadFile = File(...)) -> dict[str, Any]:
    ensure_upload_dirs()
    if photo_type not in C.PHOTO_TYPES:
        raise HTTPException(status_code=422, detail=f"Ungueltiger Fototyp: {photo_type}")
    if not fetch_one("SELECT id FROM inventory_items WHERE id = %s", (item_id,)):
        raise HTTPException(status_code=404, detail="Item not found")
    suffix = _validated_suffix(file, C.ALLOWED_IMAGE_SUFFIXES)
    data = await _read_limited(file)
    digest = hashlib.sha256(data).hexdigest()
    filename = f"{item_id}-{photo_type}-{digest[:12]}{suffix}"
    path = Path(settings.upload_root, "originals", filename)
    path.write_bytes(data)
    stamped = Path(settings.upload_root, "stamped", filename)
    stamped.write_bytes(data)
    row = execute(
        """
        INSERT INTO item_photos (item_id, photo_type, original_path, stamped_path, original_hash, metadata_json)
        VALUES (%s, %s, %s, %s, %s, %s::jsonb)
        ON CONFLICT (item_id, photo_type, original_hash) DO NOTHING
        RETURNING *
        """,
        (item_id, photo_type, str(path), str(stamped), digest, '{"phase":"1","stamp":"pending-worker"}'),
    )
    if row is None:
        # Wiederholter Sync derselben Datei: kein Duplikat, bestehende Zeile liefern.
        return fetch_one(
            "SELECT * FROM item_photos WHERE item_id = %s AND photo_type = %s AND original_hash = %s",
            (item_id, photo_type, digest),
        )
    audit("photo_uploaded", "inventory_item", item_id, {"photo_id": str(row["id"]), "photo_type": photo_type})
    return row


@app.post("/items/{item_id}/audio")
async def upload_audio(
    item_id: str,
    transcript: str | None = None,
    file: UploadFile | None = File(None),
    transcript_form: str | None = Form(None, alias="transcript"),
) -> dict[str, Any]:
    ensure_upload_dirs()
    if not fetch_one("SELECT id FROM inventory_items WHERE id = %s", (item_id,)):
        raise HTTPException(status_code=404, detail="Item not found")
    text = transcript_form if transcript_form is not None else transcript
    audio_hash: str | None = None
    if file:
        # Nur die gepruefte Endung uebernehmen, nie den Client-Dateinamen
        # (Path-Traversal-Schutz).
        suffix = _validated_suffix(file, C.ALLOWED_AUDIO_SUFFIXES)
        data = await _read_limited(file)
        audio_hash = hashlib.sha256(data).hexdigest()
        path = Path(settings.upload_root, "audio", f"{item_id}-{audio_hash[:12]}{suffix}")
        path.write_bytes(data)
        transcript_status = "completed" if text else "pending"
    else:
        if not text:
            raise HTTPException(status_code=422, detail="Weder Audiodatei noch Transkript uebergeben")
        audio_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
        path = Path(settings.upload_root, "audio", f"{item_id}-{audio_hash[:12]}.txt")
        path.write_text(text, encoding="utf-8")
        transcript_status = "completed"
    row = execute(
        """
        INSERT INTO item_audio_notes (item_id, audio_path, transcript, transcript_status, audio_hash)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (item_id, audio_hash) WHERE audio_hash IS NOT NULL DO NOTHING
        RETURNING *
        """,
        (item_id, str(path), text, transcript_status, audio_hash),
    )
    if row is None:
        return fetch_one(
            "SELECT * FROM item_audio_notes WHERE item_id = %s AND audio_hash = %s",
            (item_id, audio_hash),
        )
    audit("audio_saved", "inventory_item", item_id, {"note_id": str(row["id"])})
    return row


def _safe_file_response(stored_path: str, subdirs: tuple[str, ...]) -> FileResponse:
    """Liefert Dateien nur aus dem Upload-Root aus (Containment-Check)."""
    upload_root = Path(settings.upload_root).resolve()
    target = Path(stored_path).resolve()
    if not any(target.is_relative_to(upload_root / sub) for sub in subdirs):
        raise HTTPException(status_code=404, detail="Datei nicht verfuegbar")
    if not target.exists():
        raise HTTPException(status_code=404, detail="Datei nicht gefunden")
    return FileResponse(target, filename=target.name)


@app.get("/files/photo/{photo_id}")
def serve_photo(photo_id: str, variant: str = "original") -> FileResponse:
    row = fetch_one("SELECT * FROM item_photos WHERE id = %s", (photo_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Foto nicht gefunden")
    path = row["stamped_path"] if variant == "stamped" and row.get("stamped_path") else row["original_path"]
    return _safe_file_response(path, ("originals", "stamped"))


@app.get("/files/audio/{note_id}")
def serve_audio(note_id: str) -> FileResponse:
    row = fetch_one("SELECT * FROM item_audio_notes WHERE id = %s", (note_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Audionotiz nicht gefunden")
    return _safe_file_response(row["audio_path"], ("audio",))


# ---------------------------------------------------------------------------
# KI
# ---------------------------------------------------------------------------

@app.post("/items/{item_id}/ai/run")
def run_ai(item_id: str) -> dict[str, Any]:
    item = fetch_one("SELECT id, status FROM inventory_items WHERE id = %s", (item_id,))
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    previous_status = item["status"]
    execute("UPDATE inventory_items SET status = 'ki_laeuft', updated_at = now() WHERE id = %s RETURNING id", (item_id,))
    try:
        suggestion = build_ai_suggestion(item_id)
        row = execute(
            """
            INSERT INTO ai_results (item_id, ai_type, model_used, input_sources, result_json, confidence)
            VALUES (%s, 'phase1_stub', 'litellm-placeholder', %s::jsonb, %s::jsonb, %s)
            RETURNING *
            """,
            (item_id, '["photos","audio"]', json_dumps(suggestion), suggestion["confidence"]),
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
    except HTTPException:
        raise
    except Exception as exc:
        # Vorher blieb das Item bei jedem Fehler dauerhaft in 'ki_laeuft' haengen.
        log.exception("KI-Lauf fehlgeschlagen fuer Item %s", item_id)
        execute(
            "UPDATE inventory_items SET status = 'ki_fehler', updated_at = now() WHERE id = %s AND status = 'ki_laeuft' RETURNING id",
            (item_id,),
        )
        try:
            execute(
                """
                INSERT INTO ai_results (item_id, ai_type, model_used, result_json, status, error_message)
                VALUES (%s, 'phase1_stub', 'litellm-placeholder', '{}'::jsonb, 'failed', %s)
                RETURNING id
                """,
                (item_id, str(exc)[:500]),
            )
        except Exception:
            log.exception("Fehlerprotokoll fuer KI-Lauf konnte nicht gespeichert werden")
        raise HTTPException(status_code=502, detail="KI-Lauf fehlgeschlagen, Status auf ki_fehler gesetzt") from exc
    audit("ai_result_created", "inventory_item", item_id, suggestion)
    _ = previous_status  # bewusst: bei Erfolg setzt der Stub 'ki_fertig'
    return row


@app.get("/items/{item_id}/ai-results")
def ai_results(item_id: str) -> list[dict[str, Any]]:
    return fetch_all("SELECT * FROM ai_results WHERE item_id = %s ORDER BY created_at DESC", (item_id,))


# ---------------------------------------------------------------------------
# Objektklassen & Pflichtfelder
# ---------------------------------------------------------------------------

@app.get("/object-classes")
def object_classes() -> list[dict[str, Any]]:
    return fetch_all("SELECT * FROM object_classes ORDER BY name")


@app.get("/meta/field-requirements")
def all_field_requirements() -> list[dict[str, Any]]:
    """Alle Pflichtfelder in einem Aufruf – fuer den Offline-Stammdaten-Cache
    der mobilen Erfassung (ein Request beim Join statt N beim Klassenwechsel)."""
    return fetch_all("SELECT * FROM field_requirements ORDER BY object_class_id, sort_order")


@app.get("/object-classes/{class_id}/requirements")
def requirements(class_id: str) -> list[dict[str, Any]]:
    return fetch_all("SELECT * FROM field_requirements WHERE object_class_id = %s ORDER BY sort_order", (class_id,))


@app.post("/object-classes")
def create_object_class(body: ObjectClassIn) -> dict[str, Any]:
    row = execute(
        """
        INSERT INTO object_classes (name, slug, description, default_commercial_category, requires_accounting_review)
        VALUES (%s, %s, %s, %s, %s) RETURNING *
        """,
        (body.name, body.slug, body.description, body.default_commercial_category, body.requires_accounting_review),
    )
    audit("object_class_created", "object_class", str(row["id"]), row)
    return row


@app.patch("/object-classes/{class_id}")
def update_object_class(class_id: str, body: ObjectClassPatch) -> dict[str, Any]:
    row = execute(
        """
        UPDATE object_classes
        SET description = COALESCE(%s, description),
            default_commercial_category = COALESCE(%s, default_commercial_category),
            updated_at = now()
        WHERE id = %s RETURNING *
        """,
        (body.description, body.default_commercial_category, class_id),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Objektklasse nicht gefunden")
    return row


# ---------------------------------------------------------------------------
# Buchhaltung
# ---------------------------------------------------------------------------

@app.get("/accounting/tasks")
def accounting_tasks() -> list[dict[str, Any]]:
    return fetch_all("SELECT * FROM accounting_tasks ORDER BY created_at DESC")


@app.patch("/accounting/tasks/{task_id}")
def patch_accounting_task(task_id: str, body: TaskPatch) -> dict[str, Any]:
    row = execute(
        """
        UPDATE accounting_tasks
        SET status = COALESCE(%s, status), comment = COALESCE(%s, comment),
            completed_at = CASE WHEN %s = 'completed' THEN now() ELSE completed_at END
        WHERE id = %s RETURNING *
        """,
        (body.status, body.comment, body.status, task_id),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Aufgabe nicht gefunden")
    audit("accounting_task_changed", "accounting_task", task_id, row)
    return row


@app.get("/items/{item_id}/accounting")
def item_accounting(item_id: str) -> dict[str, Any]:
    row = fetch_one("SELECT * FROM item_accounting_data WHERE item_id = %s", (item_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Buchhaltungsdaten nicht gefunden")
    return row


@app.patch("/items/{item_id}/accounting")
def patch_item_accounting(item_id: str, body: AccountingPatch) -> dict[str, Any]:
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
        (body.commercial_category, body.cost_center, body.asset_number, body.book_value, body.accounting_status, item_id),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Buchhaltungsdaten nicht gefunden")
    audit("accounting_changed", "inventory_item", item_id, row)
    return row


# ---------------------------------------------------------------------------
# Export & Audit
# ---------------------------------------------------------------------------

def excel_value(value: Any) -> Any:
    if isinstance(value, datetime) and value.tzinfo is not None:
        return value.replace(tzinfo=None)
    return value


@app.post("/sessions/{session_id}/export/excel")
def export_excel(session_id: str) -> dict[str, Any]:
    ensure_upload_dirs()
    session = get_session(session_id)
    rows = _session_items_with_context(session_id)
    wb = Workbook()
    ws = wb.active
    ws.title = "Inventur"
    headers = [
        "Inventar-ID", "temporaere ID", "Objektart", "Objektklasse", "Kategorie", "Marke",
        "Modell", "Seriennummer", "Zustand", "Altersquelle", "geschaetztes Alter",
        "Herstellungsdatum", "Anschaffungsdatum", "Betrieb", "Gebaeude", "Raum",
        "Verantwortlicher", "Kostenstelle", "kaufmaennische Kategorie",
        "Buchhaltungsstatus", "Buchhaltung pruefen", "Status", "Pruefstatus",
        "KI-Konfidenz", "Foto vorhanden", "Typenschildfoto vorhanden", "DOT-Foto vorhanden",
        "Erfasst von", "Geprueft von", "Finalisiert am", "Bemerkung",
    ]
    ws.append(headers)
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
    # Zeitstempel im Namen: Exporte sind Belege und duerfen sich nicht
    # gegenseitig ueberschreiben.
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = Path(settings.upload_root, "exports", f"session-{session_id}-{stamp}.xlsx")
    wb.save(path)
    export = execute(
        "INSERT INTO exports (session_id, file_path) VALUES (%s, %s) RETURNING *",
        (session_id, str(path)),
    )
    audit("export_created", "inventory_session", session_id, export)
    return export


@app.get("/exports/{export_id}/download")
def download_export(export_id: str) -> FileResponse:
    row = fetch_one("SELECT * FROM exports WHERE id = %s", (export_id,))
    if not row or not os.path.exists(row["file_path"]):
        raise HTTPException(status_code=404, detail="Export not found")
    return FileResponse(row["file_path"], filename=Path(row["file_path"]).name)


@app.get("/items/{item_id}/audit-log")
def item_audit(item_id: str) -> list[dict[str, Any]]:
    return fetch_all("SELECT * FROM audit_log WHERE entity_id = %s ORDER BY created_at DESC", (item_id,))


@app.get("/sessions/{session_id}/audit-log")
def session_audit(session_id: str) -> list[dict[str, Any]]:
    return fetch_all(
        "SELECT * FROM audit_log WHERE entity_id = %s OR entity_type = 'inventory_item' ORDER BY created_at DESC LIMIT 200",
        (session_id,),
    )


# ---------------------------------------------------------------------------
# Live-Events (SSE)
# ---------------------------------------------------------------------------

@app.get("/sessions/{session_id}/events")
async def session_events(session_id: str, request: Request):
    """SSE-Stream. Haertung: DB-Arbeit laeuft im Threadpool (vorher
    blockierte der synchrone Code den gesamten Event-Loop), Stream endet
    sauber bei Client-Disconnect und meldet Fehler statt still zu sterben."""

    async def stream():
        last_payload = ""
        while True:
            if await request.is_disconnected():
                return
            try:
                items = await asyncio.to_thread(_session_items_with_context, session_id)
                payload = json.dumps({"items": items}, default=str)
                if payload != last_payload:
                    yield f"data: {payload}\n\n"
                    last_payload = payload
            except Exception:
                log.exception("SSE-Aktualisierung fehlgeschlagen")
                yield 'data: {"error": "refresh_failed"}\n\n'
            await asyncio.sleep(2)

    return StreamingResponse(stream(), media_type="text/event-stream")
