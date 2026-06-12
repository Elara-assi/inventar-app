from __future__ import annotations

import hashlib
import html
import json
import os
import re
import secrets
import shutil
from datetime import date, datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import httpx
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from openpyxl import Workbook
from openpyxl.drawing.image import Image as ExcelImage
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from PIL import Image as PillowImage, ImageOps
from pydantic import BaseModel

from .db import db_pool_status, execute, fetch_all, fetch_one
from .logic import (
    WORKSHOP_REFERENCE_CATALOG,
    audit,
    build_ai_suggestion,
    create_rework_tasks,
    finalization_blockers,
    load_inventory_history_references,
    load_special_tool_references,
    next_inventory_id,
    normalize_bga_object_class,
    plausible_value_limit,
    tokenize_reference_text,
)
from .migrations import run_migrations
from .security import (
    bearer_token_from_request,
    create_access_token,
    create_mobile_session_token,
    current_user_from_request,
    decode_access_token,
    hash_password,
    request_id,
    verify_password,
)
from .settings import settings

AI_ACTIVE_STATUSES = {
    "ki_wartet",
    "ki_laeuft",
    "ki_schnell_wartet",
    "ki_schnell_laeuft",
    "ki_pruefung_wartet",
    "ki_pruefung_laeuft",
}
AI_ACTIVE_STATUS_SQL = ", ".join(f"'{status}'" for status in sorted(AI_ACTIVE_STATUSES))
AI_STALE_INTERVAL_SQL = "8 minutes"

app = FastAPI(title="Inventar API", version="0.1.0-phase1")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_context_middleware(request: Request, call_next):
    rid = request.headers.get("x-request-id") or request_id()
    request.state.request_id = rid
    auth_error = authorize_request(request)
    if auth_error:
        return auth_error
    response = await call_next(request)
    response.headers["x-request-id"] = rid
    return response


PUBLIC_PATH_PREFIXES = (
    "/health",
    "/auth/login",
    "/sessions/join",
)

MOBILE_ALLOWED_PREFIXES = (
    "/meta/bootstrap",
    "/items",
    "/offline-sync/photos",
    "/offline-sync/items",
    "/offline-sync/status",
    "/offline-sync/reconcile",
    "/mobile-diagnostics",
    "/uploads/photos",
)


def json_error(status_code: int, detail: str, request: Request | None = None):
    from fastapi.responses import JSONResponse

    response = JSONResponse({"detail": detail}, status_code=status_code)
    if request is not None:
        origin = request.headers.get("origin")
        allowed_origins = settings.cors_origin_list()
        if origin and ("*" in allowed_origins or origin in allowed_origins):
            response.headers["access-control-allow-origin"] = origin
            response.headers["access-control-allow-credentials"] = "true"
            response.headers["vary"] = "Origin"
        response.headers["x-request-id"] = getattr(request.state, "request_id", request_id())
    return response


def authorize_request(request: Request):
    if request.method == "OPTIONS":
        return None
    path = request.url.path
    if any(path.startswith(prefix) for prefix in PUBLIC_PATH_PREFIXES):
        return None
    token = bearer_token_from_request(request)
    if not token:
        return json_error(401, "Anmeldung erforderlich", request)
    try:
        payload = decode_access_token(token)
    except HTTPException as exc:
        return json_error(exc.status_code, str(exc.detail), request)
    request.state.auth = payload
    if payload.get("kind") == "mobile_session":
        device_id = str(payload.get("device_id") or "")
        session_id = str(payload.get("session_id") or "")
        device = fetch_one(
            "SELECT id, revoked_at FROM session_devices WHERE id = %s AND session_id = %s",
            (device_id, session_id),
        ) if device_id and session_id else None
        if not device or device.get("revoked_at"):
            return json_error(403, "Mobile Session wurde widerrufen. Bitte QR-Code neu koppeln.", request)
        if any(path.startswith(prefix) for prefix in MOBILE_ALLOWED_PREFIXES):
            return None
        return json_error(403, "Mobile Session darf diese Funktion nicht ausführen", request)
    return None

INVENTORY_TYPE_LABELS = {
    "bga": "Betriebs- und Geschäftsausstattung",
    "tires_wheels": "Reifen und Räder",
    "special_tools": "Spezialwerkzeuge",
}


def inventory_type_label(value: Any) -> str:
    return INVENTORY_TYPE_LABELS.get(str(value or "bga"), INVENTORY_TYPE_LABELS["bga"])


class LoginIn(BaseModel):
    email: str
    password: str = "!Scherer!"


class SessionIn(BaseModel):
    location_id: str | None = None
    location_name: str | None = None
    building_id: str | None = None
    building_name: str | None = None
    room_id: str | None = None
    room_name: str | None = None
    started_by: str | None = None
    inventory_type: str = "bga"


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
    inventory_type: str = "bga"
    client_item_id: str | None = None
    source_device_id: str | None = None
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
    specification: str | None = None
    construction_year: str | None = None
    function_ok: str = "nicht_geprueft"
    uvv_status: str = "unklar"
    uvv_valid_until: date | None = None
    inspection_book_available: str = "unklar"
    remark: str | None = None
    type_plate_status: str = "nicht_geprueft"


class OfflineReconcilePackageIn(BaseModel):
    client_item_id: str
    client_photo_ids: list[str] = []


class OfflineReconcileIn(BaseModel):
    session_id: str
    source_device_id: str
    packages: list[OfflineReconcilePackageIn] = []


class ItemPatch(BaseModel):
    object_type: str | None = None
    object_class_id: str | None = None
    brand: str | None = None
    model: str | None = None
    serial_number: str | None = None
    condition: str | None = None
    condition_note: str | None = None
    value_estimate: float | None = None
    estimated_age_years: float | None = None
    age_source: str | None = None
    age_verification_status: str | None = None
    status: str | None = None
    review_status: str | None = None
    commercial_category: str | None = None
    accounting_status: str | None = None
    inventory_type: str | None = None
    specification: str | None = None
    construction_year: str | None = None
    function_ok: str | None = None
    uvv_status: str | None = None
    uvv_valid_until: date | None = None
    inspection_book_available: str | None = None
    remark: str | None = None
    type_plate_status: str | None = None


class TireWheelDataBase(BaseModel):
    set_type: str | None = None
    season: str | None = None
    manufacturer: str | None = None
    profile_model: str | None = None
    tire_size: str | None = None
    load_index: str | None = None
    speed_index: str | None = None
    dot: str | None = None
    production_week: int | None = None
    production_year: int | None = None
    tread_depth_front_left: float | None = None
    tread_depth_front_right: float | None = None
    tread_depth_rear_left: float | None = None
    tread_depth_rear_right: float | None = None
    tread_depth_single: float | None = None
    rim_present: bool | None = None
    rim_type: str | None = None
    rim_condition: str | None = None
    tire_condition: str | None = None
    damage_note: str | None = None
    set_complete: bool | None = None
    storage_location: str | None = None
    remark: str | None = None


class TireWheelDataCreate(TireWheelDataBase):
    set_type: str = "satz"
    season: str = "unklar"


class TireWheelDataUpdate(TireWheelDataBase):
    pass


class TireWheelDataResponse(TireWheelDataBase):
    id: str | None = None
    item_id: str
    created_at: datetime | None = None
    updated_at: datetime | None = None


class LearningExampleIn(BaseModel):
    notes: str | None = None


class ReopenIn(BaseModel):
    reason: str | None = None


def ensure_upload_dirs() -> None:
    for sub in ["originals", "stamped", "audio", "exports", "temp"]:
        Path(settings.upload_root, sub).mkdir(parents=True, exist_ok=True)


def demo_user_id() -> str | None:
    row = fetch_one("SELECT id FROM users WHERE email = %s", (settings.demo_user_email,))
    return str(row["id"]) if row else None


def default_tenant_id() -> str | None:
    row = fetch_one("SELECT id FROM tenants WHERE slug = %s", (settings.default_tenant_slug,))
    return str(row["id"]) if row else None


def safe_upload_path(value: str) -> Path:
    root = Path(settings.upload_root).resolve()
    path = Path(value).resolve()
    if root not in path.parents and path != root:
        raise HTTPException(status_code=403, detail="Uploadpfad nicht erlaubt")
    return path


def detect_image_mime(data: bytes) -> str | None:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"RIFF") and b"WEBP" in data[:16]:
        return "image/webp"
    if len(data) > 12 and data[4:8] == b"ftyp":
        brand = data[8:12].lower()
        if brand in {b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"}:
            return "image/heic"
    return None


def safe_photo_suffix(filename: str | None, mime_type: str | None) -> str:
    suffix = Path(filename or "").suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}:
        return suffix
    return {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/heic": ".heic",
        "image/heif": ".heif",
    }.get(mime_type or "", ".jpg")


def safe_audio_suffix(filename: str | None, content_type: str | None) -> str:
    suffix = Path(filename or "").suffix.lower()
    if suffix in {".webm", ".m4a", ".mp3", ".mp4", ".wav", ".ogg", ".aac", ".txt"}:
        return suffix
    declared = (content_type or "").split(";")[0].strip().lower()
    return {
        "audio/webm": ".webm",
        "audio/mp4": ".m4a",
        "audio/mpeg": ".mp3",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/ogg": ".ogg",
        "audio/aac": ".aac",
        "video/mp4": ".m4a",
        "text/plain": ".txt",
    }.get(declared, ".bin")


def validate_photo_upload(file: UploadFile, data: bytes) -> tuple[str, str]:
    if not data:
        raise HTTPException(status_code=400, detail="Foto-Datei ist leer")
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="Foto ist zu groß")
    declared = (file.content_type or "").split(";")[0].strip().lower()
    detected = detect_image_mime(data)
    allowed = settings.allowed_upload_mime_list()
    effective = detected or declared
    if effective not in allowed:
        raise HTTPException(status_code=415, detail="Nur JPEG, PNG, WebP oder HEIC Fotos sind erlaubt")
    if declared and declared not in allowed:
        raise HTTPException(status_code=415, detail="Foto-Dateityp ist nicht erlaubt")
    return effective, safe_photo_suffix(file.filename, effective)


def require_item_session(item_id: str) -> dict[str, Any]:
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
    return row


def require_item_session_open(item_id: str) -> dict[str, Any]:
    row = require_item_session(item_id)
    if row["session_status"] != "open":
        raise HTTPException(status_code=409, detail="Raum ist abgeschlossen")
    return row


def next_sequence_number(session_id: str) -> int:
    row = fetch_one(
        "SELECT COALESCE(max(sequence_number), 0)::int + 1 AS next_number FROM inventory_items WHERE session_id = %s",
        (session_id,),
    )
    return int((row or {"next_number": 1})["next_number"])


def photo_type_aliases(kind: str) -> tuple[str, ...]:
    if kind == "object":
        return ("object", "object_front", "tire_overview")
    if kind == "nameplate":
        return ("nameplate", "type_plate")
    if kind == "condition":
        return ("condition", "condition_detail", "object_back")
    if kind == "tire_overview":
        return ("tire_overview",)
    return (kind,)


def has_photo_type(item_id: str, kind: str) -> bool:
    aliases = photo_type_aliases(kind)
    placeholders = ", ".join(["%s"] * len(aliases))
    row = fetch_one(
        f"SELECT 1 AS ok FROM item_photos WHERE item_id = %s AND photo_type IN ({placeholders}) LIMIT 1",
        (item_id, *aliases),
    )
    return bool(row)


def has_ai_object_photo(item_id: str) -> bool:
    return has_photo_type(item_id, "object")


def upsert_rework_task(item_id: str, role: str, field: str, priority: str = "normal", comment: str | None = None) -> None:
    upsert_rework_task_for_type(item_id, "bga_check", role, field, priority, comment)


def upsert_rework_task_for_type(
    item_id: str,
    task_type: str,
    role: str,
    field: str,
    priority: str = "normal",
    comment: str | None = None,
) -> None:
    execute(
        """
        INSERT INTO accounting_tasks (item_id, task_type, assigned_role, missing_field, priority, comment)
        SELECT %s, %s, %s, %s, %s, %s
        WHERE NOT EXISTS (
          SELECT 1 FROM accounting_tasks
          WHERE item_id = %s AND task_type = %s AND missing_field = %s AND status = 'open'
        )
        RETURNING id
        """,
        (item_id, task_type, role, field, priority, comment or field, item_id, task_type, field),
    )


def complete_satisfied_bga_rework_tasks(item_id: str, item: dict[str, Any]) -> None:
    function_resolved = item.get("function_ok") == "ja"
    uvv_resolved = item.get("uvv_status") in {"vorhanden", "nicht_uvv_pflichtig"}
    inspection_book_resolved = item.get("inspection_book_available") in {"ja", "nein", "nicht_erforderlich"}

    if function_resolved and uvv_resolved:
        execute(
            """
            UPDATE accounting_tasks
            SET status = 'completed', completed_at = now()
            WHERE item_id = %s
              AND status = 'open'
              AND assigned_role IN ('Erfasser', 'Technik')
              AND lower(COALESCE(missing_field, '')) LIKE '%%funktion%%'
              AND lower(COALESCE(missing_field, '')) LIKE '%%uvv%%'
            RETURNING id
            """,
            (item_id,),
        )
    if function_resolved:
        execute(
            """
            UPDATE accounting_tasks
            SET status = 'completed', completed_at = now()
            WHERE item_id = %s
              AND status = 'open'
              AND assigned_role IN ('Erfasser', 'Technik')
              AND lower(COALESCE(missing_field, '')) LIKE '%%funktion%%'
              AND lower(COALESCE(missing_field, '')) NOT LIKE '%%uvv%%'
            RETURNING id
            """,
            (item_id,),
        )
    if uvv_resolved:
        execute(
            """
            UPDATE accounting_tasks
            SET status = 'completed', completed_at = now()
            WHERE item_id = %s
              AND status = 'open'
              AND assigned_role IN ('Erfasser', 'Technik')
              AND lower(COALESCE(missing_field, '')) LIKE '%%uvv%%'
              AND lower(COALESCE(missing_field, '')) NOT LIKE '%%funktion%%'
            RETURNING id
            """,
            (item_id,),
        )
    if inspection_book_resolved:
        execute(
            """
            UPDATE accounting_tasks
            SET status = 'completed', completed_at = now()
            WHERE item_id = %s
              AND status = 'open'
              AND assigned_role IN ('Erfasser', 'Technik')
              AND lower(COALESCE(missing_field, '')) LIKE '%%prüfbuch%%'
            RETURNING id
            """,
            (item_id,),
        )


def parse_dot_week_year(value: str | None) -> tuple[int | None, int | None, bool]:
    raw = re.sub(r"\D", "", value or "")
    if len(raw) < 4:
        return None, None, False
    token = raw[-4:]
    week = int(token[:2])
    year_suffix = int(token[2:])
    current_year = date.today().year
    current_suffix = current_year % 100
    year = 2000 + year_suffix if year_suffix <= current_suffix + 1 else 1900 + year_suffix
    if week < 1 or week > 53:
        return None, None, False
    if year < 1980 or year > current_year + 1:
        return None, None, False
    return week, year, True


def normalize_tire_wheel_payload(data: dict[str, Any]) -> dict[str, Any]:
    if "dot" in data:
        week, year, valid = parse_dot_week_year(data.get("dot"))
        data["production_week"] = week if valid else None
        data["production_year"] = year if valid else None
    return data


def tire_tread_values(data: dict[str, Any]) -> list[float]:
    fields = [
        "tread_depth_front_left",
        "tread_depth_front_right",
        "tread_depth_rear_left",
        "tread_depth_rear_right",
        "tread_depth_single",
    ]
    values = []
    for field in fields:
        value = data.get(field)
        if value is None:
            continue
        try:
            values.append(float(value))
        except (TypeError, ValueError):
            continue
    return values


def tire_tread_missing(data: dict[str, Any]) -> bool:
    if data.get("set_type") == "einzelreifen":
        return data.get("tread_depth_single") is None
    if data.get("set_type") == "satz":
        return any(data.get(field) is None for field in [
            "tread_depth_front_left",
            "tread_depth_front_right",
            "tread_depth_rear_left",
            "tread_depth_rear_right",
        ])
    return True


def tire_warning_limit(season: str | None) -> float:
    return 3.0 if season == "sommer" else 4.0


def run_bga_rework_check(item_id: str) -> None:
    item = fetch_one("SELECT * FROM inventory_items WHERE id = %s", (item_id,))
    if not item or item.get("inventory_type") != "bga":
        return
    execute(
        """
        UPDATE accounting_tasks
        SET status = 'completed', completed_at = now()
        WHERE item_id = %s AND task_type = 'bga_check' AND status = 'open'
        RETURNING id
        """,
        (item_id,),
    )

    if not has_photo_type(item_id, "object"):
        upsert_rework_task(item_id, "Erfasser", "Objektfoto fehlt", "hoch", "Pflichtfoto aus der Zählliste fehlt.")
    if not str(item.get("object_type") or "").strip():
        upsert_rework_task(item_id, "Erfasser", "Bezeichnung fehlt", "hoch", "Bezeichnung aus der Zählliste fehlt.")
    if item.get("condition") in {None, "", "unklar"}:
        upsert_rework_task(item_id, "Erfasser", "Zustand unklar", "normal", "Zustand muss für die Aufnahme eingeordnet werden.")
    if item.get("function_ok") == "nein":
        upsert_rework_task(item_id, "Technik", "Funktion nicht in Ordnung", "hoch", "Funktionsstatus muss technisch geklärt werden.")

    complete_satisfied_bga_rework_tasks(item_id, item)

    open_critical = fetch_one(
        """
        SELECT
          count(*)::int AS count,
          count(*) FILTER (WHERE assigned_role = 'Erfasser')::int AS erfasser_count,
          count(*) FILTER (WHERE assigned_role = 'Technik')::int AS technik_count
        FROM accounting_tasks
        WHERE item_id = %s AND status = 'open' AND assigned_role IN ('Erfasser', 'Technik')
        """,
        (item_id,),
    )
    if open_critical and int(open_critical["count"]) > 0:
        next_review_status = "nacharbeit_erfasser" if int(open_critical.get("erfasser_count") or 0) > 0 else "nacharbeit_technik"
        execute(
            """
            UPDATE inventory_items
            SET review_status = CASE
                  WHEN review_status = 'finalisiert' THEN review_status
                  ELSE %s
                END,
                status = CASE WHEN status = 'finalisiert' THEN status ELSE 'nacharbeit_noetig' END,
                updated_at = now()
            WHERE id = %s
            RETURNING id
            """,
            (next_review_status, item_id),
        )
    else:
        execute(
            """
            UPDATE inventory_items
            SET review_status = CASE WHEN review_status IN ('erfasst', 'nacharbeit_erfasser', 'nacharbeit_technik') THEN 'finalisierbar' ELSE review_status END,
                updated_at = now()
            WHERE id = %s
            RETURNING id
            """,
            (item_id,),
        )


def run_tire_wheel_rework_check(item_id: str) -> None:
    item = fetch_one("SELECT * FROM inventory_items WHERE id = %s", (item_id,))
    if not item or item.get("inventory_type") != "tires_wheels":
        return
    execute(
        """
        UPDATE accounting_tasks
        SET status = 'completed', completed_at = now()
        WHERE item_id = %s AND task_type = 'tire_wheel_check' AND status = 'open'
        RETURNING id
        """,
        (item_id,),
    )
    data = fetch_one("SELECT * FROM item_tire_wheel_data WHERE item_id = %s", (item_id,)) or {}

    def add(role: str, field: str, priority: str = "normal", comment: str | None = None) -> None:
        upsert_rework_task_for_type(item_id, "tire_wheel_check", role, field, priority, comment)

    if not has_photo_type(item_id, "tire_overview"):
        add("Erfasser", "Gesamtfoto Reifen/Radsatz fehlt", "hoch", "Pflichtfoto für Reifen/Räder fehlt.")

    dot = str(data.get("dot") or "").strip()
    _, _, dot_valid = parse_dot_week_year(dot)
    if not dot or not dot_valid:
        add("Erfasser", "DOT fehlt oder unklar", "hoch", "DOT muss als WWYY plausibel erfasst werden.")

    if not str(data.get("tire_size") or "").strip():
        add("Erfasser", "Reifengröße fehlt", "hoch", "Reifengröße muss erfasst oder per Foto nachgewiesen werden.")

    if data.get("season") in {None, "", "unklar"}:
        add("Erfasser", "Saison unklar", "normal", "Sommer, Winter oder Ganzjahr muss eingeordnet werden.")

    if tire_tread_missing(data):
        add("Erfasser", "Profiltiefe fehlt", "hoch", "Profiltiefe muss für Satz oder Einzelreifen erfasst werden.")
    else:
        values = tire_tread_values(data)
        if any(value < 1.6 for value in values):
            add("Technik", "Profiltiefe unter gesetzlicher Mindestgrenze", "hoch", "Mindestens ein Reifen liegt unter 1,6 mm.")
        elif any(value < tire_warning_limit(data.get("season")) for value in values):
            add("Prüfer", "Profiltiefe unter fachlichem Warnwert", "normal", "Reifen liegt unter dem internen Warnwert.")

    if data.get("set_complete") is False:
        add("Erfasser", "Satz unvollständig", "hoch", "Radsatz ist nicht vollständig erfasst.")

    if str(data.get("damage_note") or "").strip():
        add("Technik", "Schaden vorhanden", "hoch", "Schaden muss fachlich bewertet werden.")

    if data.get("rim_present") is True and data.get("rim_type") in {None, "", "unklar"}:
        add("Erfasser", "Felgentyp unklar", "normal", "Felgentyp Stahl, Alu oder unklar prüfen.")

    if data.get("rim_present") is True and str(data.get("rim_condition") or "").strip().lower() in {"", "unklar"}:
        add("Erfasser", "Felgenzustand unklar", "normal", "Felgenzustand muss eingeordnet werden.")

    open_critical = fetch_one(
        """
        SELECT count(*)::int AS count
        FROM accounting_tasks
        WHERE item_id = %s AND status = 'open' AND assigned_role IN ('Erfasser', 'Technik')
        """,
        (item_id,),
    )
    if open_critical and int(open_critical["count"]) > 0:
        execute(
            """
            UPDATE inventory_items
            SET review_status = CASE
                  WHEN review_status = 'finalisiert' THEN review_status
                  ELSE 'nacharbeit_erfasser'
                END,
                status = CASE WHEN status = 'finalisiert' THEN status ELSE 'nacharbeit_noetig' END,
                updated_at = now()
            WHERE id = %s
            RETURNING id
            """,
            (item_id,),
        )
    else:
        execute(
            """
            UPDATE inventory_items
            SET review_status = CASE WHEN review_status IN ('erfasst', 'nacharbeit_erfasser', 'nacharbeit_technik') THEN 'finalisierbar' ELSE review_status END,
                updated_at = now()
            WHERE id = %s
            RETURNING id
            """,
            (item_id,),
        )


def run_inventory_rework_check(item_id: str) -> None:
    item = fetch_one("SELECT inventory_type FROM inventory_items WHERE id = %s", (item_id,))
    if not item:
        return
    if item.get("inventory_type") == "bga":
        run_bga_rework_check(item_id)
    elif item.get("inventory_type") == "tires_wheels":
        run_tire_wheel_rework_check(item_id)


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
        add("history", "Historie", "info")

    uvv_resolved = row.get("uvv_status") in {"vorhanden", "nicht_uvv_pflichtig"}
    function_ok_resolved = row.get("function_ok") == "ja"
    inspection_book_resolved = row.get("inspection_book_available") in {"ja", "nicht_erforderlich"}

    for match in history_matches:
        if match.get("uvv_due") and not uvv_resolved:
            add("uvv", "UVV prüfen", "danger")
        if match.get("maintenance_due"):
            add("maintenance", "Wartung prüfen", "warn")
        if match.get("inspection_book_missing") and not inspection_book_resolved:
            add("inspection_book", "Prüfbuch fehlt", "warn")
        if match.get("missing"):
            add("target_missing", "Soll/Fehlt prüfen", "danger")
        if match.get("defective") and not function_ok_resolved:
            add("defective", "Defekt prüfen", "danger")

    for task in tasks:
        role = task.get("assigned_role")
        if role == "Technik":
            add("technical_rework", "Technik-Nacharbeit", "warn")
        elif role in {"Buchhaltung", "Auswertung"}:
            add("later_review", "Spätere Auswertung", "info")
        elif role == "Erfasser":
            add("capture_rework", "Erfasser-Nacharbeit", "warn")

    return hints


@app.on_event("startup")
def startup() -> None:
    run_migrations()
    ensure_upload_dirs()
    try:
        execute(
            f"""
            UPDATE inventory_items
            SET status = 'ki_pruefung_offen',
                updated_at = now()
            WHERE status IN ({AI_ACTIVE_STATUS_SQL})
              AND status <> 'finalisiert'
            """,
        )
    except Exception as exc:
        print(f"AI startup cleanup skipped: {type(exc).__name__}: {str(exc)[:160]}")


@app.get("/health")
def health() -> dict[str, Any]:
    db_ok = False
    migrations_ok = False
    upload_root_ok = False
    upload_free_mb = None
    try:
        db_ok = bool(fetch_one("SELECT 1 AS ok"))
        migrations_ok = bool(fetch_one("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ok")["ok"])
    except Exception:
        db_ok = False
        migrations_ok = False
    try:
        ensure_upload_dirs()
        test_path = Path(settings.upload_root, "temp", ".health-write")
        test_path.write_text("ok", encoding="utf-8")
        test_path.unlink(missing_ok=True)
        upload_root_ok = True
        usage = shutil.disk_usage(settings.upload_root)
        upload_free_mb = round(usage.free / 1024 / 1024)
    except Exception:
        upload_root_ok = False
    return {
        "ok": bool(db_ok and upload_root_ok),
        "database": db_ok,
        "migrations": migrations_ok,
        "upload_root": upload_root_ok,
        "upload_free_mb": upload_free_mb,
        "db_pool": db_pool_status(),
        "auth_secret_configured": settings.auth_secret_configured,
        "phase": "enterprise-foundation",
    }


def resolve_location(location_id: str | None, location_name: str | None) -> dict[str, Any]:
    name = location_name.strip() if location_name else None
    if name:
        location = fetch_one("SELECT * FROM locations WHERE lower(name) = lower(%s)", (name,))
        if not location:
            location = execute(
                """
                INSERT INTO locations (tenant_id, name, code)
                VALUES (%s, %s, %s)
                RETURNING *
                """,
                (default_tenant_id(), name, f"BETR-{secrets.token_hex(2).upper()}"),
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
        INSERT INTO locations (tenant_id, name, code)
        VALUES (%s, 'Betrieb', %s)
        RETURNING *
        """,
        (default_tenant_id(), f"LOC-{secrets.token_hex(2).upper()}"),
    )
    audit("location_created", "location", str(location["id"]), location)
    return location


@app.post("/auth/login")
def login(body: LoginIn) -> dict[str, Any]:
    login_name = body.email.strip()
    user = fetch_one(
        """
        SELECT u.*, t.slug AS tenant_slug, array_remove(array_agg(r.slug), null) AS roles
        FROM users u
        LEFT JOIN tenants t ON t.id = u.tenant_id
        LEFT JOIN user_roles ur ON ur.user_id = u.id
        LEFT JOIN roles r ON r.id = ur.role_id
        WHERE (lower(u.email) = lower(%s) OR lower(u.display_name) = lower(%s)) AND u.active = true
        GROUP BY u.id, t.slug
        ORDER BY CASE WHEN lower(u.email) = lower(%s) THEN 0 ELSE 1 END, u.created_at ASC
        LIMIT 1
        """,
        (login_name, login_name, login_name),
    )
    if not user or not verify_password(body.password, user.get("password_hash")):
        raise HTTPException(status_code=401, detail="Login Name oder Passwort ist falsch")
    execute("UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = %s RETURNING id", (user["id"],))
    token = create_access_token(user)
    audit("login", "user", str(user["id"]), {"login_name": login_name, "email": user.get("email")})
    return {"access_token": token, "token_type": "bearer", "user": user}


@app.get("/auth/me")
def me(request: Request) -> dict[str, Any]:
    user = current_user_from_request(request)
    if not user:
        user = fetch_one(
            """
            SELECT u.*, t.slug AS tenant_slug, array_remove(array_agg(r.slug), null) AS roles
            FROM users u
            LEFT JOIN tenants t ON t.id = u.tenant_id
            LEFT JOIN user_roles ur ON ur.user_id = u.id
            LEFT JOIN roles r ON r.id = ur.role_id
            WHERE u.email = %s
            GROUP BY u.id, t.slug
            """,
            (settings.demo_user_email,),
        )
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
        "brands": [row["name"] for row in fetch_all("SELECT name FROM brand_lexicon ORDER BY name")],
    }


def mobile_join_bootstrap(session: dict[str, Any]) -> dict[str, Any]:
    location = fetch_one(
        "SELECT id, name, code FROM locations WHERE id = %s",
        (session.get("location_id"),),
    ) if session.get("location_id") else None
    building = fetch_one(
        "SELECT id, name, location_id FROM buildings WHERE id = %s",
        (session.get("building_id"),),
    ) if session.get("building_id") else None
    room = fetch_one(
        "SELECT id, name, building_id, code, room_type FROM rooms WHERE id = %s",
        (session.get("room_id"),),
    ) if session.get("room_id") else None
    return {
        "users": [],
        "locations": [location] if location else [],
        "buildings": [building] if building else [],
        "rooms": [room] if room else [],
        "object_classes": fetch_all("SELECT id, name, slug FROM object_classes ORDER BY name"),
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
    initial_password = secrets.token_urlsafe(18)
    user = execute(
        """
        INSERT INTO users (tenant_id, email, display_name, password_hash, password_reset_required)
        VALUES (%s, %s, %s, %s, true)
        RETURNING *
        """,
        (default_tenant_id(), email, name, hash_password(initial_password)),
    )
    role = fetch_one("SELECT id FROM roles WHERE slug = %s", (body.role_slug,))
    if role:
        execute(
            "INSERT INTO user_roles (user_id, role_id) VALUES (%s, %s) ON CONFLICT DO NOTHING RETURNING user_id",
            (user["id"], role["id"]),
        )
    audit("user_created", "user", str(user["id"]), {"email": email, "role_slug": body.role_slug, "password_reset_required": True})
    return {**user, "initial_password": initial_password}


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
        INSERT INTO locations (tenant_id, name, code, address)
        VALUES (%s, %s, %s, %s)
        RETURNING *
        """,
        (default_tenant_id(), name, code, body.address),
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
                INSERT INTO buildings (tenant_id, location_id, name, code)
                VALUES (%s, %s, %s, %s)
                RETURNING *
                """,
                (location.get("tenant_id") or default_tenant_id(), location["id"], building_name, f"GEB-{secrets.token_hex(3).upper()}"),
            )
            audit("building_created", "building", str(building["id"]), building)
        building_id = str(building["id"])
    if not building_id or not fetch_one("SELECT id FROM buildings WHERE id = %s", (building_id,)):
        raise HTTPException(status_code=400, detail="Gebäude auswählen oder neues Gebäude eingeben")
    code = (body.code or f"RAUM-{secrets.token_hex(3).upper()}").strip()
    row = execute(
        """
        INSERT INTO rooms (tenant_id, building_id, name, code, room_type)
        VALUES ((SELECT tenant_id FROM buildings WHERE id = %s), %s, %s, %s, %s)
        RETURNING *
        """,
        (building_id, building_id, name, code, body.room_type),
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
    inventory_type = body.inventory_type if body.inventory_type in {"bga", "tires_wheels", "special_tools"} else "bga"
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
                    INSERT INTO buildings (tenant_id, location_id, name, code)
                    VALUES (%s, %s, %s, %s)
                    RETURNING *
                    """,
                    (location.get("tenant_id") or default_tenant_id(), location_id, building_name, f"FREI-{secrets.token_hex(3).upper()}"),
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
                    INSERT INTO buildings (tenant_id, location_id, name, code)
                    VALUES (%s, %s, 'Hauptgebäude', %s)
                    RETURNING *
                    """,
                    (location.get("tenant_id") or default_tenant_id(), location["id"], f"HG-{secrets.token_hex(2).upper()}"),
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
                INSERT INTO rooms (tenant_id, building_id, name, code, room_type)
                VALUES (%s, %s, %s, %s, 'workspace')
                RETURNING *
                """,
                (building.get("tenant_id") or default_tenant_id(), building_id, room_name, f"FREI-{secrets.token_hex(3).upper()}"),
            )
            audit("room_created", "room", str(room["id"]), room)
        room_id = str(room["id"])

    if not room_id:
        raise HTTPException(status_code=400, detail="Raum auswählen oder freien Raum eingeben")

    room = fetch_one(
        """
        SELECT r.*, b.location_id, COALESCE(r.tenant_id, b.tenant_id, l.tenant_id) AS tenant_id
        FROM rooms r
        JOIN buildings b ON b.id = r.building_id
        JOIN locations l ON l.id = b.location_id
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
        INSERT INTO inventory_sessions (tenant_id, location_id, building_id, room_id, join_token, started_by, inventory_type)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        RETURNING *
        """,
        (room.get("tenant_id") or default_tenant_id(), location_id, building_id, room_id, token, body.started_by, inventory_type),
    )
    audit("session_started", "inventory_session", str(row["id"]), row)
    return row


@app.get("/sessions")
def list_sessions() -> list[dict[str, Any]]:
    return fetch_all(
        """
        SELECT s.*, l.name AS location_name, b.name AS building_name, r.name AS room_name,
          starter.display_name AS started_by_name,
          COALESCE(s.inventory_type, 'bga') AS inventory_type,
          count(i.id)::int AS item_count
        FROM inventory_sessions s
        JOIN locations l ON l.id = s.location_id
        JOIN buildings b ON b.id = s.building_id
        JOIN rooms r ON r.id = s.room_id
        LEFT JOIN users starter ON starter.id = s.started_by
        LEFT JOIN inventory_items i ON i.session_id = s.id
        GROUP BY s.id, l.name, b.name, r.name, starter.display_name
        ORDER BY s.created_at DESC
        """
    )


@app.get("/sessions/{session_id}")
def get_session(session_id: str) -> dict[str, Any]:
    row = fetch_one(
        """
        SELECT s.*, COALESCE(s.inventory_type, 'bga') AS inventory_type,
          l.name AS location_name, l.code AS location_code, b.name AS building_name, r.name AS room_name
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
    device = None
    if body.device_fingerprint:
        device = fetch_one(
            """
            SELECT *
            FROM session_devices
            WHERE session_id = %s AND device_fingerprint = %s
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (session["id"], body.device_fingerprint),
        )
        if device and device.get("revoked_at"):
            raise HTTPException(status_code=403, detail="Dieses Gerät wurde für diese Session widerrufen")
    if body.device_fingerprint:
        device = execute(
            """
            INSERT INTO session_devices (tenant_id, session_id, device_name, device_fingerprint, last_seen_at)
            VALUES (%s, %s, %s, %s, now())
            ON CONFLICT (session_id, device_fingerprint) WHERE device_fingerprint IS NOT NULL
            DO UPDATE
              SET device_name = EXCLUDED.device_name,
                  last_seen_at = now()
              WHERE session_devices.revoked_at IS NULL
            RETURNING *
            """,
            (session.get("tenant_id") or default_tenant_id(), session["id"], body.device_name, body.device_fingerprint),
        )
        if not device:
            raise HTTPException(status_code=403, detail="Dieses Gerät wurde für diese Session widerrufen")
        audit("device_seen", "session_device", str(device["id"]), device)
    else:
        device = execute(
            """
            INSERT INTO session_devices (tenant_id, session_id, device_name, device_fingerprint, last_seen_at)
            VALUES (%s, %s, %s, %s, now())
            RETURNING *
            """,
            (session.get("tenant_id") or default_tenant_id(), session["id"], body.device_name, body.device_fingerprint),
        )
        audit("device_joined", "session_device", str(device["id"]), device)
    return {
        "session": session,
        "device": device,
        "access_token": create_mobile_session_token(session, device),
        "token_type": "bearer",
        "bootstrap": mobile_join_bootstrap(session),
    }


@app.post("/sessions/{session_id}/close")
def close_session(session_id: str) -> dict[str, Any]:
    items = fetch_all("SELECT id FROM inventory_items WHERE session_id = %s", (session_id,))
    blockers = {str(i["id"]): finalization_blockers(str(i["id"])) for i in items}
    open_blockers = {k: v for k, v in blockers.items() if v}
    if open_blockers:
        raise HTTPException(status_code=409, detail={"message": "Offene Punkte für Raumabschluss", "blockers": open_blockers})
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


@app.post("/sessions/{session_id}/reopen")
def reopen_session(session_id: str, body: ReopenIn | None = None) -> dict[str, Any]:
    current = fetch_one("SELECT * FROM inventory_sessions WHERE id = %s", (session_id,))
    if not current:
        raise HTTPException(status_code=404, detail="Session nicht gefunden")
    if current["status"] == "open":
        return current
    row = execute(
        """
        UPDATE inventory_sessions
        SET status = 'open',
            closed_at = NULL,
            closed_by = NULL,
            join_token_expires_at = now() + interval '12 hours'
        WHERE id = %s
        RETURNING *
        """,
        (session_id,),
    )
    execute(
        """
        UPDATE inventory_items
        SET locked_at = NULL,
            updated_at = now()
        WHERE session_id = %s
          AND status <> 'finalisiert'
        RETURNING id
        """,
        (session_id,),
    )
    reason = (body.reason if body else None) or "Raum wurde für Korrekturen wieder geöffnet"
    execute("UPDATE inventory_items SET reopened_reason = %s WHERE session_id = %s RETURNING id", (reason, session_id))
    audit("session_reopened", "inventory_session", session_id, row, reason=reason)
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
    session_inventory_type = session.get("inventory_type") or "bga"
    if body.inventory_type and body.inventory_type != session_inventory_type:
        raise HTTPException(status_code=409, detail="Erfassungsart der Session kann nicht gemischt werden")
    if body.client_item_id and body.source_device_id:
        existing = fetch_one(
            """
            SELECT *
            FROM inventory_items
            WHERE session_id = %s AND source_device_id = %s AND client_item_id = %s
            LIMIT 1
            """,
            (body.session_id, body.source_device_id, body.client_item_id),
        )
        if existing:
            return existing
    inventory_id = body.inventory_id or next_inventory_id(session["location_code"])
    temporary_id = body.temporary_id or f"TEMP-{secrets.token_hex(4).upper()}"
    object_class_id = body.object_class_id
    if not object_class_id and session_inventory_type in {"bga", "tires_wheels", "special_tools"}:
        object_class = fetch_one("SELECT id FROM object_classes WHERE slug = %s", (session_inventory_type,))
        object_class_id = str(object_class["id"]) if object_class else None
    oc = fetch_one("SELECT * FROM object_classes WHERE id = %s", (object_class_id,)) if object_class_id else None
    sequence_number = next_sequence_number(body.session_id)
    row = execute(
        """
        INSERT INTO inventory_items (
          tenant_id, inventory_id, temporary_id, sequence_number, inventory_type,
          client_item_id, source_device_id,
          session_id, location_id, building_id, room_id,
          object_type, object_class_id, category, brand, model, serial_number, condition,
          condition_note, commercial_category, requires_accounting_review,
          accounting_relevance, created_by, specification, construction_year,
          function_ok, uvv_status, uvv_valid_until, inspection_book_available,
          remark, type_plate_status
        )
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        RETURNING *
        """,
        (
            session.get("tenant_id") or default_tenant_id(),
            inventory_id,
            temporary_id,
            sequence_number,
            session_inventory_type,
            body.client_item_id,
            body.source_device_id,
            body.session_id,
            session["location_id"],
            session["building_id"],
            session["room_id"],
            body.object_type,
            object_class_id,
            session_inventory_type,
            body.brand,
            body.model,
            body.serial_number,
            body.condition,
            body.condition_note,
            oc["default_commercial_category"] if oc else "ungeklaert",
            oc["requires_accounting_review"] if oc else False,
            oc["requires_accounting_review"] if oc else False,
            body.created_by,
            body.specification,
            body.construction_year,
            body.function_ok,
            body.uvv_status,
            body.uvv_valid_until,
            body.inspection_book_available,
            body.remark,
            body.type_plate_status,
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
    run_inventory_rework_check(str(row["id"]))
    return row


@app.get("/sessions/{session_id}/items")
def session_items(session_id: str) -> list[dict[str, Any]]:
    repair_stale_ai_statuses(session_id=session_id)
    rows = fetch_all(
        """
        SELECT i.*, oc.name AS object_class_name,
          EXISTS(SELECT 1 FROM item_photos p WHERE p.item_id = i.id AND p.photo_type IN ('object','object_front')) AS has_object_photo,
          EXISTS(SELECT 1 FROM item_photos p WHERE p.item_id = i.id AND p.photo_type IN ('nameplate','type_plate')) AS has_nameplate_photo,
          EXISTS(SELECT 1 FROM item_photos p WHERE p.item_id = i.id AND p.photo_type = 'dot') AS has_dot_photo,
          (
            SELECT p.id
            FROM item_photos p
            WHERE p.item_id = i.id AND p.photo_type IN ('object','object_front')
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
            "SELECT result_json FROM ai_results WHERE item_id = %s AND ai_type <> 'deep_dive' ORDER BY created_at DESC LIMIT 1",
            (row["id"],),
        )
        deep_dive_row = fetch_one(
            """
            SELECT result_json
            FROM ai_results
            WHERE item_id = %s AND ai_type = 'deep_dive'
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (row["id"],),
        )
        ai_result = ai_row.get("result_json") if ai_row else {}
        deep_dive = deep_dive_row.get("result_json") if deep_dive_row else None
        row["ai_summary"] = {
            "confidence": ai_result.get("confidence"),
            "notes": ai_result.get("notes"),
            "bga_detection": ai_result.get("bga_detection"),
            "nameplate_extraction": ai_result.get("nameplate_extraction"),
            "suggested_fields": ai_result.get("suggested_fields"),
            "requires_manual_review": ai_result.get("requires_manual_review") or ai_result.get("requires_review"),
            "uncertainty_reason": ai_result.get("uncertainty_reason"),
            "special_tool_matches": (ai_result.get("special_tool_matches") or [])[:3],
            "inventory_history_matches": (ai_result.get("inventory_history_matches") or [])[:3],
            "deep_dive": deep_dive,
        }
        row["process_hints"] = build_process_hints(row, ai_result, row["open_tasks"])
        row["photos"] = fetch_all(
            """
            SELECT id, photo_type, uploaded_at
            FROM item_photos
            WHERE item_id = %s
            ORDER BY uploaded_at ASC
            LIMIT 5
            """,
            (row["id"],),
        )
    return rows


TIRE_WHEEL_FIELDS = [
    "set_type",
    "season",
    "manufacturer",
    "profile_model",
    "tire_size",
    "load_index",
    "speed_index",
    "dot",
    "production_week",
    "production_year",
    "tread_depth_front_left",
    "tread_depth_front_right",
    "tread_depth_rear_left",
    "tread_depth_rear_right",
    "tread_depth_single",
    "rim_present",
    "rim_type",
    "rim_condition",
    "tire_condition",
    "damage_note",
    "set_complete",
    "storage_location",
    "remark",
]


def require_tire_wheel_item(item_id: str, require_open: bool = False) -> dict[str, Any]:
    item = require_item_session_open(item_id) if require_open else fetch_one("SELECT * FROM inventory_items WHERE id = %s", (item_id,))
    if not item:
        raise HTTPException(status_code=404, detail="Gegenstand nicht gefunden")
    if item.get("inventory_type") != "tires_wheels":
        raise HTTPException(status_code=409, detail="Gegenstand ist kein Reifen/Räder-Datensatz")
    return item


def upsert_tire_wheel_data(item_id: str, data: dict[str, Any]) -> dict[str, Any]:
    payload = normalize_tire_wheel_payload({key: value for key, value in data.items() if key in TIRE_WHEEL_FIELDS})
    if not payload:
        row = fetch_one("SELECT * FROM item_tire_wheel_data WHERE item_id = %s", (item_id,))
        if row:
            return row
        payload = {}

    insert_fields = ["item_id", *payload.keys()]
    placeholders = ", ".join(["%s"] * len(insert_fields))
    update_fields = [field for field in payload.keys() if field != "item_id"]
    update_sql = ", ".join([f"{field} = EXCLUDED.{field}" for field in update_fields])
    if update_sql:
        update_sql += ", updated_at = now()"
    else:
        update_sql = "updated_at = now()"
    row = execute(
        f"""
        INSERT INTO item_tire_wheel_data ({", ".join(insert_fields)})
        VALUES ({placeholders})
        ON CONFLICT (item_id) DO UPDATE SET {update_sql}
        RETURNING *
        """,
        (item_id, *payload.values()),
    )
    audit("tire_wheel_data_saved", "inventory_item", item_id, row)
    run_tire_wheel_rework_check(item_id)
    return row


@app.get("/items/resolve-client")
def resolve_client_item(session_id: str, source_device_id: str, client_item_id: str) -> dict[str, Any]:
    row = fetch_one(
        """
        SELECT id, session_id, source_device_id, client_item_id
        FROM inventory_items
        WHERE session_id = %s AND source_device_id = %s AND client_item_id = %s
        LIMIT 1
        """,
        (session_id, source_device_id, client_item_id),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Client item mapping not found")
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
    if row.get("inventory_type") == "tires_wheels":
        row["tire_wheel_data"] = fetch_one("SELECT * FROM item_tire_wheel_data WHERE item_id = %s", (item_id,))
    row["blockers"] = finalization_blockers(item_id)
    return row


@app.get("/items/{item_id}/tires-wheels")
def get_tire_wheel_data(item_id: str) -> dict[str, Any]:
    require_tire_wheel_item(item_id)
    row = fetch_one("SELECT * FROM item_tire_wheel_data WHERE item_id = %s", (item_id,))
    return row or {"item_id": item_id}


@app.post("/items/{item_id}/tires-wheels")
def create_tire_wheel_data(item_id: str, body: TireWheelDataCreate) -> dict[str, Any]:
    require_tire_wheel_item(item_id, require_open=True)
    data = body.model_dump(exclude_unset=True)
    return upsert_tire_wheel_data(item_id, data)


@app.patch("/items/{item_id}/tires-wheels")
def patch_tire_wheel_data(item_id: str, body: TireWheelDataUpdate) -> dict[str, Any]:
    require_tire_wheel_item(item_id, require_open=True)
    data = body.model_dump(exclude_unset=True)
    return upsert_tire_wheel_data(item_id, data)


@app.patch("/items/{item_id}")
def patch_item(item_id: str, body: ItemPatch) -> dict[str, Any]:
    require_item_session(item_id)
    data = body.model_dump(exclude_unset=True)
    if not data:
        return get_item(item_id)
    if data.get("age_source") in (None, ""):
        data["age_source"] = "unbekannt"
    if data.get("age_verification_status") in (None, ""):
        data["age_verification_status"] = "offen"
    if data.get("construction_year"):
        derived_age = construction_year_age({"construction_year": data.get("construction_year")})
        if derived_age is not None:
            typed_age = numeric_or_none(data.get("estimated_age_years"))
            if typed_age is None or abs(typed_age - derived_age) < 0.01:
                data["estimated_age_years"] = derived_age
                data["age_source"] = "baujahr"
                data["age_verification_status"] = "geprueft"
    reviewer_id = demo_user_id()
    allowed = list(data.keys())
    sql_parts = [f"{key} = %s" for key in allowed]
    if reviewer_id:
        sql_parts.append("reviewed_by = COALESCE(reviewed_by, %s)")
    sql = ", ".join(sql_parts)
    row = execute(
        f"UPDATE inventory_items SET {sql}, updated_at = now() WHERE id = %s RETURNING *",
        tuple(data[key] for key in allowed) + ((reviewer_id,) if reviewer_id else ()) + (item_id,),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Item not found")
    audit("item_changed", "inventory_item", item_id, data)
    run_inventory_rework_check(item_id)
    return get_item(item_id)


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
    require_item_session(item_id)
    blockers = finalization_blockers(item_id)
    if blockers:
        raise HTTPException(status_code=409, detail={"message": "Item has blockers", "blockers": blockers})
    user_id = demo_user_id()
    row = execute(
        """
        UPDATE inventory_items
        SET review_status = 'finalisiert', status = 'finalisiert',
            lifecycle_status = COALESCE(lifecycle_status, 'aktiv'),
            reviewed_by = COALESCE(reviewed_by, %s),
            finalized_by = COALESCE(finalized_by, %s),
            finalized_at = now(), updated_at = now()
        WHERE id = %s RETURNING *
        """,
        (user_id, user_id, item_id),
    )
    audit("item_finalized", "inventory_item", item_id, row)
    return row


@app.post("/items/{item_id}/request-rework")
def request_rework(item_id: str, body: dict[str, Any]) -> dict[str, Any]:
    require_item_session(item_id)
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
        "Auswertung": "nacharbeit_buchhaltung",
        "Erfasser": "nacharbeit_erfasser",
        "Technik": "nacharbeit_technik",
    }.get(assigned_role, "nacharbeit_pruefer")
    execute("UPDATE inventory_items SET review_status = %s WHERE id = %s RETURNING id", (review_status, item_id))
    audit("rework_requested", "inventory_item", item_id, row)
    return row


@app.post("/items/{item_id}/change-status")
def change_status(item_id: str, body: dict[str, Any]) -> dict[str, Any]:
    require_item_session(item_id)
    row = execute(
        "UPDATE inventory_items SET status = %s, review_status = COALESCE(%s, review_status), updated_at = now() WHERE id = %s RETURNING *",
        (body.get("status"), body.get("review_status"), item_id),
    )
    audit("status_changed", "inventory_item", item_id, body)
    return row


@app.post("/items/{item_id}/ai/learning-example")
def save_learning_example(item_id: str, body: LearningExampleIn | None = None) -> dict[str, Any]:
    require_item_session_open(item_id)
    item = fetch_one(
        """
        SELECT i.*, oc.name AS object_class_name
        FROM inventory_items i
        LEFT JOIN object_classes oc ON oc.id = i.object_class_id
        WHERE i.id = %s
        """,
        (item_id,),
    )
    if not item:
        raise HTTPException(status_code=404, detail="Gegenstand nicht gefunden")
    ai_row = fetch_one(
        """
        SELECT result_json
        FROM ai_results
        WHERE item_id = %s AND ai_type <> 'deep_dive'
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (item_id,),
    )
    photo_rows = fetch_all(
        "SELECT id FROM item_photos WHERE item_id = %s ORDER BY uploaded_at DESC LIMIT 5",
        (item_id,),
    )
    corrected = {
        "object_type": item.get("object_type"),
        "object_class": item.get("object_class_name"),
        "brand": item.get("brand"),
        "model": item.get("model"),
        "serial_number_present": bool(item.get("serial_number")),
        "serial_number": item.get("serial_number"),
        "specification": item.get("specification"),
        "construction_year": item.get("construction_year"),
        "condition": item.get("condition"),
        "value_estimate": item.get("value_estimate"),
        "estimated_age_years": item.get("estimated_age_years"),
        "age_source": item.get("age_source"),
        "age_verification_status": item.get("age_verification_status"),
        "commercial_category": item.get("commercial_category"),
        "reference_kind": "gepruefte_wertreferenz" if item.get("value_estimate") is not None or item.get("estimated_age_years") is not None else "ki_lernbeispiel",
    }
    note = (body.notes if body else None) or "Vom Prüfer als geprüfte Wertreferenz markiert"
    existing = fetch_one("SELECT id FROM ai_learning_examples WHERE item_id = %s AND approved = true ORDER BY created_at DESC LIMIT 1", (item_id,))
    if existing:
        row = execute(
            """
            UPDATE ai_learning_examples
            SET object_class_id = %s, object_class_name = %s, object_type = %s,
                brand = %s, model = %s, serial_number = %s, condition = %s,
                corrected_json = %s::jsonb, ai_suggestion_json = %s::jsonb,
                photo_ids = %s, notes = %s
            WHERE id = %s
            RETURNING *
            """,
            (
                item.get("object_class_id"),
                item.get("object_class_name"),
                item.get("object_type"),
                item.get("brand"),
                item.get("model"),
                item.get("serial_number"),
                item.get("condition"),
                json_string(corrected),
                json_string(ai_row.get("result_json") if ai_row else {}),
                [photo["id"] for photo in photo_rows],
                note,
                existing["id"],
            ),
        )
    else:
        row = execute(
            """
            INSERT INTO ai_learning_examples (
              item_id, session_id, object_class_id, object_class_name, object_type,
              brand, model, serial_number, condition, corrected_json, ai_suggestion_json,
              photo_ids, notes, approved
            )
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s,%s,true)
            RETURNING *
            """,
            (
                item_id,
                item.get("session_id"),
                item.get("object_class_id"),
                item.get("object_class_name"),
                item.get("object_type"),
                item.get("brand"),
                item.get("model"),
                item.get("serial_number"),
                item.get("condition"),
                json_string(corrected),
                json_string(ai_row.get("result_json") if ai_row else {}),
                [photo["id"] for photo in photo_rows],
                note,
            ),
        )
    audit("ai_learning_example_created", "inventory_item", item_id, {"learning_example_id": str(row["id"]), **corrected})
    return row


@app.post("/items/{item_id}/photos")
async def upload_photo(
    item_id: str,
    photo_type: str = "object",
    client_photo_id: str | None = None,
    source_device_id: str | None = None,
    file: UploadFile = File(...),
) -> dict[str, Any]:
    row, _ = await save_item_photo(
        item_id=item_id,
        file=file,
        photo_type=photo_type,
        client_photo_id=client_photo_id,
        source_device_id=source_device_id,
    )
    return row


@app.get("/offline-sync/status")
def offline_sync_status(
    request: Request,
    session_id: str,
    source_device_id: str,
    client_item_id: str,
    client_photo_ids: str | None = None,
) -> dict[str, Any]:
    auth = getattr(request.state, "auth", {}) or {}
    if auth.get("kind") == "mobile_session" and str(auth.get("session_id") or "") != session_id:
        raise HTTPException(status_code=403, detail="Sync-Status gehört nicht zu dieser mobilen Session")
    session = get_session(session_id)
    expected_photo_ids = [
        value.strip()
        for value in (client_photo_ids or "").split(",")
        if value.strip()
    ]
    item = fetch_one(
        """
        SELECT id, session_id, source_device_id, client_item_id, object_type, sequence_number, status, review_status
        FROM inventory_items
        WHERE session_id = %s AND source_device_id = %s AND client_item_id = %s
        LIMIT 1
        """,
        (session_id, source_device_id, client_item_id),
    )
    if not item:
        return {
            "session_id": session_id,
            "session_status": session.get("status"),
            "source_device_id": source_device_id,
            "client_item_id": client_item_id,
            "server_item_id": None,
            "item_status": "missing",
            "photos": [],
            "known_client_photo_ids": [],
            "missing_client_photo_ids": expected_photo_ids,
        }
    photos = fetch_all(
        """
        SELECT id, item_id, photo_type, client_photo_id, original_path, uploaded_at
        FROM item_photos
        WHERE item_id = %s AND source_device_id = %s
        ORDER BY uploaded_at, id
        """,
        (item["id"], source_device_id),
    )
    all_known_ids = [str(photo["client_photo_id"]) for photo in photos if photo.get("client_photo_id")]
    all_known_set = set(all_known_ids)
    if expected_photo_ids:
        expected_set = set(expected_photo_ids)
        known_ids = [photo_id for photo_id in all_known_ids if photo_id in expected_set]
    else:
        known_ids = all_known_ids
    return {
        "session_id": session_id,
        "session_status": session.get("status"),
        "source_device_id": source_device_id,
        "client_item_id": client_item_id,
        "server_item_id": str(item["id"]),
        "item_status": "synced",
        "server_item": item,
        "photos": photos,
        "known_client_photo_ids": known_ids,
        "missing_client_photo_ids": [photo_id for photo_id in expected_photo_ids if photo_id not in all_known_set],
    }


@app.post("/offline-sync/reconcile")
def offline_sync_reconcile(request: Request, body: OfflineReconcileIn) -> dict[str, Any]:
    auth = getattr(request.state, "auth", {}) or {}
    if auth.get("kind") == "mobile_session" and str(auth.get("session_id") or "") != body.session_id:
        raise HTTPException(status_code=403, detail="Sync-Reconcile gehört nicht zu dieser mobilen Session")

    session = fetch_one(
        "SELECT id, status, inventory_type FROM inventory_sessions WHERE id = %s",
        (body.session_id,),
    )
    if not session:
        return {
            "session_id": body.session_id,
            "source_device_id": body.source_device_id,
            "session_status": "missing",
            "packages": [
                {
                    "client_item_id": package.client_item_id,
                    "status": "discardable",
                    "server_item_id": None,
                    "known_client_photo_ids": [],
                    "missing_client_photo_ids": list(dict.fromkeys(package.client_photo_ids)),
                    "session_status": "missing",
                }
                for package in body.packages
            ],
        }

    packages: list[dict[str, Any]] = []
    for package in body.packages:
        expected_photo_ids = [value for value in dict.fromkeys(package.client_photo_ids) if value]
        if not package.client_item_id.strip() or not body.source_device_id.strip():
            packages.append({
                "client_item_id": package.client_item_id,
                "status": "foreign_or_invalid",
                "server_item_id": None,
                "known_client_photo_ids": [],
                "missing_client_photo_ids": expected_photo_ids,
                "session_status": session.get("status"),
            })
            continue

        item = fetch_one(
            """
            SELECT id, session_id, source_device_id, client_item_id, object_type, sequence_number, status, review_status
            FROM inventory_items
            WHERE session_id = %s AND source_device_id = %s AND client_item_id = %s
            LIMIT 1
            """,
            (body.session_id, body.source_device_id, package.client_item_id),
        )
        if not item:
            packages.append({
                "client_item_id": package.client_item_id,
                "status": "session_closed" if session.get("status") != "open" else "missing",
                "server_item_id": None,
                "known_client_photo_ids": [],
                "missing_client_photo_ids": expected_photo_ids,
                "session_status": session.get("status"),
            })
            continue

        photos = fetch_all(
            """
            SELECT id, item_id, photo_type, client_photo_id, original_path, uploaded_at
            FROM item_photos
            WHERE item_id = %s AND source_device_id = %s
            ORDER BY uploaded_at, id
            """,
            (item["id"], body.source_device_id),
        )
        all_known_ids = [str(photo["client_photo_id"]) for photo in photos if photo.get("client_photo_id")]
        all_known_set = set(all_known_ids)
        known_ids = [photo_id for photo_id in all_known_ids if not expected_photo_ids or photo_id in set(expected_photo_ids)]
        missing_ids = [photo_id for photo_id in expected_photo_ids if photo_id not in all_known_set]
        status = "session_closed" if session.get("status") != "open" else ("missing_photos" if missing_ids else "synced")
        packages.append({
            "client_item_id": package.client_item_id,
            "status": status,
            "server_item_id": str(item["id"]),
            "server_item": item,
            "known_client_photo_ids": known_ids,
            "missing_client_photo_ids": missing_ids,
            "session_status": session.get("status"),
        })

    return {
        "session_id": body.session_id,
        "source_device_id": body.source_device_id,
        "session_status": session.get("status"),
        "packages": packages,
    }


@app.post("/offline-sync/photos")
async def offline_sync_photo(
    session_id: str = Form(...),
    source_device_id: str = Form(...),
    client_item_id: str = Form(...),
    client_photo_id: str = Form(...),
    photo_type: str = Form("object_front"),
    file: UploadFile = File(...),
) -> dict[str, Any]:
    session = get_session(session_id)
    if session["status"] != "open":
        raise HTTPException(status_code=409, detail="Raum ist abgeschlossen")
    item = fetch_one(
        """
        SELECT *
        FROM inventory_items
        WHERE session_id = %s AND source_device_id = %s AND client_item_id = %s
        LIMIT 1
        """,
        (session_id, source_device_id, client_item_id),
    )
    if not item:
        raise HTTPException(status_code=409, detail="Objekt ist noch nicht synchronisiert")
    row, already_exists = await save_item_photo(
        item_id=str(item["id"]),
        file=file,
        photo_type=photo_type,
        client_photo_id=client_photo_id,
        source_device_id=source_device_id,
    )
    return {
        "server_item_id": str(item["id"]),
        "server_photo_id": str(row["id"]),
        "client_item_id": client_item_id,
        "client_photo_id": client_photo_id,
        "photo_type": row.get("photo_type") or photo_type,
        "status": "already_exists" if already_exists else "synced",
    }


async def save_item_photo(
    item_id: str,
    file: UploadFile,
    photo_type: str = "object",
    client_photo_id: str | None = None,
    source_device_id: str | None = None,
) -> tuple[dict[str, Any], bool]:
    ensure_upload_dirs()
    require_item_session_open(item_id)
    if client_photo_id and source_device_id:
        existing = fetch_one(
            """
            SELECT *
            FROM item_photos
            WHERE item_id = %s AND source_device_id = %s AND client_photo_id = %s
            LIMIT 1
            """,
            (item_id, source_device_id, client_photo_id),
        )
        if existing:
            return existing, True
    photo_count = fetch_one("SELECT count(*)::int AS count FROM item_photos WHERE item_id = %s", (item_id,))
    if photo_count and int(photo_count["count"]) >= 5:
        raise HTTPException(status_code=409, detail="Maximal 5 Fotos pro Gegenstand möglich")
    data = await file.read()
    mime_type, suffix = validate_photo_upload(file, data)
    digest = hashlib.sha256(data).hexdigest()
    duplicate = fetch_one(
        "SELECT * FROM item_photos WHERE item_id = %s AND original_hash = %s LIMIT 1",
        (item_id, digest),
    )
    if duplicate:
        return duplicate, True
    filename = f"{item_id}-{photo_type}-{digest[:12]}{suffix}"
    path = Path(settings.upload_root, "originals", filename)
    path.write_bytes(data)
    stamped = Path(settings.upload_root, "stamped", filename)
    stamped.write_bytes(data)
    row = execute(
        """
        INSERT INTO item_photos (
          tenant_id, item_id, photo_type, original_path, stamped_path, original_hash,
          client_photo_id, source_device_id, metadata_json
        )
        VALUES ((SELECT tenant_id FROM inventory_items WHERE id = %s), %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
        RETURNING *
        """,
        (
            item_id,
            item_id,
            photo_type,
            str(path),
            str(stamped),
            digest,
            client_photo_id,
            source_device_id,
            json.dumps({"phase": "1", "stamp": "pending-worker", "mime_type": mime_type, "size": len(data)}),
        ),
    )
    audit("photo_uploaded", "inventory_item", item_id, row)
    run_inventory_rework_check(item_id)
    return row, False


@app.get("/offline-sync/recent")
def offline_sync_recent(request: Request, limit: int = 15) -> list[dict[str, Any]]:
    """Zuletzt erfasste Objekte dieses Geraets in dieser Session.

    Grundlage fuer die Nacherfassung am Handy: ein gespeichertes Objekt
    wieder oeffnen und Fotos/Felder ergaenzen. Bewusst auf das eigene
    Geraet begrenzt (source_device_id), damit der Bundle-Upsert beim
    erneuten Speichern dasselbe Objekt trifft und keine Dublette entsteht.
    """
    auth = getattr(request.state, "auth", None) or {}
    if auth.get("kind") != "mobile_session":
        raise HTTPException(status_code=403, detail="Nur fuer gekoppelte Geraete")
    session_id = str(auth.get("session_id") or "")
    device_id = str(auth.get("device_id") or "")
    if not session_id or not device_id:
        raise HTTPException(status_code=403, detail="Session/Geraet unbekannt")
    limit = max(1, min(int(limit), 30))
    rows = fetch_all(
        """
        SELECT i.id, i.client_item_id, i.sequence_number, i.object_type, i.specification,
               i.serial_number, i.construction_year, i.condition, i.condition_note,
               i.function_ok, i.uvv_status, i.uvv_valid_until, i.inspection_book_available,
               i.remark, i.type_plate_status, i.object_class_id, i.captured_at, i.locked_at,
               COALESCE(p.photo_types, '{}') AS photo_types
        FROM inventory_items i
        LEFT JOIN LATERAL (
          SELECT array_agg(DISTINCT photo_type) AS photo_types
          FROM item_photos WHERE item_id = i.id
        ) p ON true
        WHERE i.session_id = %s AND i.source_device_id = %s
        ORDER BY i.captured_at DESC
        LIMIT %s
        """,
        (session_id, device_id, limit),
    )
    return rows


@app.post("/offline-sync/items")
async def offline_sync_item_bundle(payload: str = Form(...), files: list[UploadFile] = File(default=[])) -> dict[str, Any]:
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Sync-Paket ist kein gueltiges JSON") from exc
    item_payload = parsed.get("item") if isinstance(parsed.get("item"), dict) else parsed
    photo_meta = parsed.get("photos") if isinstance(parsed.get("photos"), list) else []
    try:
        body = ItemIn(**item_payload)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Sync-Paket ist unvollstaendig: {exc}") from exc
    if not body.client_item_id or not body.source_device_id:
        raise HTTPException(status_code=422, detail="client_item_id und source_device_id sind fuer Offline-Sync erforderlich")
    session = get_session(body.session_id)
    if session["status"] != "open":
        raise HTTPException(status_code=409, detail="Raum ist abgeschlossen")
    session_inventory_type = session.get("inventory_type") or "bga"
    if body.inventory_type and body.inventory_type != session_inventory_type:
        raise HTTPException(status_code=409, detail="Erfassungsart der Session kann nicht gemischt werden")

    existing_before = fetch_one(
        """
        SELECT *
        FROM inventory_items
        WHERE session_id = %s AND source_device_id = %s AND client_item_id = %s
        LIMIT 1
        """,
        (body.session_id, body.source_device_id, body.client_item_id),
    )
    item = existing_before or create_item(body)
    update_data = {
        "object_type": body.object_type,
        "brand": body.brand,
        "model": body.model,
        "serial_number": body.serial_number,
        "condition": body.condition,
        "condition_note": body.condition_note,
        "created_by": body.created_by,
        "specification": body.specification,
        "construction_year": body.construction_year,
        "function_ok": body.function_ok,
        "uvv_status": body.uvv_status,
        "uvv_valid_until": body.uvv_valid_until,
        "inspection_book_available": body.inspection_book_available,
        "remark": body.remark,
        "type_plate_status": body.type_plate_status,
    }
    if body.object_class_id:
        update_data["object_class_id"] = body.object_class_id
    fields = list(update_data.keys())
    item = execute(
        f"""
        UPDATE inventory_items
        SET {", ".join(f"{field} = %s" for field in fields)}, updated_at = now()
        WHERE id = %s
        RETURNING *
        """,
        tuple(update_data[field] for field in fields) + (item["id"],),
    )
    audit("offline_item_synced", "inventory_item", str(item["id"]), {"client_item_id": body.client_item_id, "photos": len(photo_meta)})
    run_inventory_rework_check(str(item["id"]))

    photo_results: list[dict[str, Any]] = []
    for index, meta in enumerate(photo_meta):
        client_photo_id = str(meta.get("client_photo_id") or "") if isinstance(meta, dict) else ""
        photo_type = str(meta.get("photo_type") or "object_front") if isinstance(meta, dict) else "object_front"
        if index >= len(files):
            photo_results.append({
                "client_photo_id": client_photo_id,
                "photo_type": photo_type,
                "status": "failed",
                "error": "Datei fehlt im Sync-Paket",
            })
            continue
        try:
            row, already_exists = await save_item_photo(
                item_id=str(item["id"]),
                file=files[index],
                photo_type=photo_type,
                client_photo_id=client_photo_id or None,
                source_device_id=body.source_device_id,
            )
            photo_results.append({
                "client_photo_id": client_photo_id,
                "photo_type": photo_type,
                "status": "already_exists" if already_exists else "synced",
                "server_photo_id": str(row["id"]),
            })
        except Exception as exc:
            detail = exc.detail if isinstance(exc, HTTPException) else str(exc)
            photo_results.append({
                "client_photo_id": client_photo_id,
                "photo_type": photo_type,
                "status": "failed",
                "error": detail,
            })
    return {
        "server_item_id": str(item["id"]),
        "client_item_id": body.client_item_id,
        "created_or_updated": "updated" if existing_before else "created",
        "photo_results": photo_results,
    }


@app.post("/mobile-diagnostics")
async def mobile_diagnostics(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    ensure_upload_dirs()
    auth = getattr(request.state, "auth", {}) or {}
    body_session_id = str(((body.get("allgemein") or {}) if isinstance(body.get("allgemein"), dict) else {}).get("session_id") or "")
    auth_session_id = str(auth.get("session_id") or "")
    if auth.get("kind") == "mobile_session" and auth_session_id and body_session_id and body_session_id != auth_session_id:
        raise HTTPException(status_code=403, detail="Diagnose gehört nicht zu dieser mobilen Session")
    session_id = body_session_id or auth_session_id or "unknown"
    diagnostic_id = f"{datetime.utcnow().strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(4)}"
    path = Path(settings.upload_root, "temp", f"mobile-sync-{diagnostic_id}.json")
    payload = {
        "diagnostic_id": diagnostic_id,
        "received_at": datetime.utcnow().isoformat() + "Z",
        "request_id": getattr(request.state, "request_id", None),
        "auth": {
            "kind": auth.get("kind"),
            "session_id": auth_session_id or None,
            "device_id": auth.get("device_id"),
        },
        "body": body,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    audit(
        "mobile_sync_diagnostic",
        "inventory_session",
        session_id if session_id != "unknown" else None,
        {
            "diagnostic_id": diagnostic_id,
            "path": str(path),
            "queue_summary": body.get("queue_summary") if isinstance(body.get("queue_summary"), dict) else None,
        },
    )
    return {"id": diagnostic_id, "stored": True}


@app.post("/items/{item_id}/audio")
async def upload_audio(
    item_id: str,
    transcript: str | None = None,
    file: UploadFile | None = File(None),
    transcript_form: str | None = Form(None, alias="transcript"),
) -> dict[str, Any]:
    ensure_upload_dirs()
    require_item_session_open(item_id)
    text = transcript_form if transcript_form is not None else transcript
    audio_hash: str | None = None
    path = Path(settings.upload_root, "audio", f"{item_id}-{secrets.token_hex(4)}.txt")
    if file:
        data = await file.read()
        if not data:
            raise HTTPException(status_code=400, detail="Audio-Datei ist leer")
        if len(data) > settings.max_upload_bytes:
            raise HTTPException(status_code=413, detail="Audio-Datei ist zu gross")
        suffix = safe_audio_suffix(file.filename, file.content_type)
        audio_hash = hashlib.sha256(data).hexdigest()
        path = safe_upload_path(str(Path(settings.upload_root, "audio", f"{item_id}-{audio_hash[:16]}{suffix}")))
        path.write_bytes(data)
        # Diktat-Pipeline: Audio ohne Transkript wartet auf den Whisper-Worker.
        transcript_status = "completed" if text else "pending"
    else:
        if not text:
            raise HTTPException(status_code=400, detail="Weder Audiodatei noch Transkript uebergeben")
        audio_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
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
        # Wiederholter Sync derselben Aufnahme (Offline-Queue): keine Dublette.
        return fetch_one(
            "SELECT * FROM item_audio_notes WHERE item_id = %s AND audio_hash = %s",
            (item_id, audio_hash),
        )
    audit("audio_saved", "inventory_item", item_id, row)
    return row



@app.post("/items/{item_id}/ai/run")
def run_ai(item_id: str, background_tasks: BackgroundTasks, mode: str = "fast") -> dict[str, Any]:
    require_item_session_open(item_id)
    active = current_active_ai_job(item_id)
    if active:
        return {
            "item_id": item_id,
            "status": active.get("status"),
            "stage": "review" if mode == "review" else "fast",
            "message": "KI läuft bereits für diesen Artikel",
            "already_running": True,
        }
    if not has_ai_object_photo(item_id):
        return {
            "item_id": item_id,
            "status": "skipped",
            "stage": "review" if mode == "review" else "fast",
            "message": "KI-Vorschlag erst nach Objektfoto möglich. Bitte Objektfoto aufnehmen und erneut starten.",
        }
    normalized_mode = "review" if mode == "review" else "fast"
    expected_generation = ai_job_generation_for_item(item_id)
    queued_status = ai_status_for_mode(normalized_mode, "queued")
    update_ai_item_status(item_id, queued_status, expected_generation)
    background_tasks.add_task(process_ai_item, item_id, normalized_mode, expected_generation)
    audit("ai_job_queued", "inventory_item", item_id, {"status": queued_status, "stage": normalized_mode, "expected_generation": expected_generation})
    label = "Prüf-KI" if normalized_mode == "review" else "Schnell-KI"
    return {"item_id": item_id, "status": queued_status, "stage": normalized_mode, "message": f"{label} läuft im Hintergrund"}

@app.get("/items/{item_id}/ai/status")
def get_ai_status(item_id: str, scope: str = "fast") -> dict[str, Any]:
    require_item_session_open(item_id)
    normalized_scope = "deep_dive" if scope in {"deep_dive", "deep-dive"} else "review" if scope == "review" else "fast"
    repair_stale_ai_statuses(item_id=item_id)
    item = fetch_one(
        "SELECT id, object_type, status, updated_at FROM inventory_items WHERE id = %s",
        (item_id,),
    )
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    result_type = ai_result_type_for_scope(normalized_scope)
    latest = fetch_one(
        """
        SELECT result_json, created_at, status
        FROM ai_results
        WHERE item_id = %s AND ai_type = %s
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (item_id, result_type),
    )
    result = latest.get("result_json") if latest else None
    state = status_state_for_item_status(normalized_scope, item.get("status"))
    if result and state == "idle":
        state = "completed"
    messages = {
        "fast": {
            "queued": "Schnell-KI startet.",
            "running": "Schnell-KI erkennt Bezeichnung und Typenschild.",
            "completed": "Vorschlag bereit.",
            "cancelled": "KI wurde abgebrochen.",
            "idle": "Noch kein Schnell-KI-Lauf.",
        },
        "review": {
            "queued": "Pruef-KI startet.",
            "running": "Pruef-KI prueft den Datensatz.",
            "completed": "Pruefvorschlag bereit.",
            "cancelled": "KI wurde abgebrochen.",
            "idle": "Noch kein Pruef-KI-Lauf.",
        },
        "deep_dive": {
            "queued": "KI-Webrecherche startet.",
            "running": "KI-Webrecherche sammelt Quellen.",
            "completed": "Recherche-Dossier bereit.",
            "cancelled": "KI-Webrecherche wurde abgebrochen.",
            "idle": "Noch keine KI-Webrecherche.",
        },
    }
    return {
        "item_id": item_id,
        "scope": normalized_scope,
        "state": state,
        "message": messages[normalized_scope].get(state, "KI-Status unbekannt."),
        "result_preview": result,
        "updated_fields": ai_updated_fields(result),
        "can_cancel": state in {"queued", "running"},
        "started_at": item.get("updated_at") if state in {"queued", "running"} else None,
        "completed_at": latest.get("created_at") if latest and result else None,
        "item_status": item.get("status"),
    }


@app.post("/items/{item_id}/ai/deep-dive")
def run_ai_deep_dive(item_id: str, background_tasks: BackgroundTasks) -> dict[str, Any]:
    require_item_session_open(item_id)
    active = current_active_ai_job(item_id)
    if active:
        return {
            "item_id": item_id,
            "stage": "deep_dive",
            "status": active.get("status"),
            "message": "KI läuft bereits für diesen Artikel",
            "already_running": True,
        }
    expected_generation = ai_job_generation_for_item(item_id)
    update_ai_item_status(item_id, ai_status_for_mode("review", "queued"), expected_generation, final_only_guard=True)
    background_tasks.add_task(process_deep_dive_item, item_id, expected_generation)
    audit("ai_deep_dive_queued", "inventory_item", item_id, {"stage": "deep_dive", "expected_generation": expected_generation})
    return {
        "item_id": item_id,
        "stage": "deep_dive",
        "status": "queued",
        "message": "KI Deep Dive gestartet: Websuche, Alters- und Wertschätzung laufen im Hintergrund",
    }


@app.post("/items/{item_id}/ai/cancel")
def cancel_ai_item(item_id: str) -> dict[str, Any]:
    require_item_session_open(item_id)
    row = execute(
        f"""
        UPDATE inventory_items
        SET status = 'ki_pruefung_offen',
            ai_cancel_generation = COALESCE(ai_cancel_generation, 0) + 1,
            ai_cancelled_at = now(),
            updated_at = now()
        WHERE id = %s
          AND status IN ({AI_ACTIVE_STATUS_SQL})
          AND status <> 'finalisiert'
        RETURNING id, object_type, status, updated_at
        """,
        (item_id,),
    )
    audit("ai_job_cancelled", "inventory_item", item_id, {"status": row.get("status") if row else "not_active"})
    return {
        "item_id": item_id,
        "status": row.get("status") if row else "not_active",
        "message": "KI-Prozess abgebrochen. Du kannst ihn später neu starten.",
    }


@app.post("/sessions/{session_id}/ai/cancel")
def cancel_session_ai(session_id: str) -> dict[str, Any]:
    session = fetch_one("SELECT id, status FROM inventory_sessions WHERE id = %s", (session_id,))
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    active_rows = fetch_all(
        f"""
        SELECT id
        FROM inventory_items
        WHERE session_id = %s
          AND status IN ({AI_ACTIVE_STATUS_SQL})
        """,
        (session_id,),
    )
    generation_row = execute(
        """
        UPDATE inventory_sessions
        SET ai_cancel_generation = COALESCE(ai_cancel_generation, 0) + 1,
            ai_cancelled_at = now()
        WHERE id = %s
        RETURNING id, ai_cancel_generation, ai_cancelled_at
        """,
        (session_id,),
    )
    fetch_all(
        f"""
        UPDATE inventory_items
        SET status = 'ki_pruefung_offen',
            updated_at = now()
        WHERE session_id = %s
          AND status IN ({AI_ACTIVE_STATUS_SQL})
          AND status <> 'finalisiert'
        RETURNING id
        """,
        (session_id,),
    )
    generation = int((generation_row or {}).get("ai_cancel_generation") or 0)
    audit(
        "session_ai_cancelled",
        "inventory_session",
        session_id,
        {"cancelled": len(active_rows), "ai_cancel_generation": generation},
    )
    return {
        "session_id": session_id,
        "cancelled": len(active_rows),
        "ai_cancel_generation": generation,
        "status": "ki_pruefung_offen",
        "message": f"{len(active_rows)} KI-Prozess(e) im Raum gestoppt.",
    }


@app.post("/sessions/{session_id}/ai/review")
def run_session_review_ai(session_id: str, background_tasks: BackgroundTasks) -> dict[str, Any]:
    session = fetch_one("SELECT id, status, COALESCE(ai_cancel_generation, 0) AS ai_cancel_generation FROM inventory_sessions WHERE id = %s", (session_id,))
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session["status"] != "open":
        raise HTTPException(status_code=409, detail="Raum ist abgeschlossen")

    repair_stale_ai_statuses(session_id=session_id)
    rows = fetch_all(
        f"""
        SELECT i.id, COALESCE(i.ai_cancel_generation, 0) AS ai_cancel_generation
        FROM inventory_items i
        WHERE session_id = %s
          AND finalized_at IS NULL
          AND locked_at IS NULL
          AND status NOT IN ({AI_ACTIVE_STATUS_SQL}, 'finalisiert')
          AND EXISTS (
            SELECT 1 FROM item_photos p
            WHERE p.item_id = i.id AND p.photo_type IN ('object', 'object_front')
          )
        ORDER BY created_at
        """,
        (session_id,),
    )
    expected_generation = int(session.get("ai_cancel_generation") or 0)
    for row in rows:
        item_id = str(row["id"])
        item_generation = {"session": expected_generation, "item": int(row.get("ai_cancel_generation") or 0)}
        update_ai_item_status(item_id, ai_status_for_mode("review", "queued"), item_generation)
        background_tasks.add_task(process_ai_item, item_id, "review", item_generation)
    audit("session_ai_review_queued", "inventory_session", session_id, {"queued": len(rows), "expected_generation": expected_generation})
    return {"session_id": session_id, "queued": len(rows), "status": "ki_pruefung_wartet"}


def json_string(value: Any) -> str:
    import json

    return json.dumps(value, default=str)


def excel_value(value: Any) -> Any:
    if isinstance(value, datetime) and value.tzinfo is not None:
        return value.replace(tzinfo=None)
    return value


def format_excel_datetime(value: Any) -> str | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    return str(value)


def label_status(value: Any) -> str:
    labels = {
        "erfasst": "Erfasst",
        "ki_vorgefuellt": "KI vorgefüllt",
        "nacharbeit_erfasser": "Noch zu ergänzen: Erfasser",
        "nacharbeit_pruefer": "Noch zu ergänzen: Prüfer",
        "nacharbeit_buchhaltung": "Später auswerten",
        "nacharbeit_technik": "Noch zu ergänzen: Technik",
        "finalisierbar": "Finalisierbar",
        "geprueft": "Geprüft",
        "finalisiert": "Finalisiert",
        "ki_schnell_wartet": "Schnell-KI wartet",
        "ki_schnell_laeuft": "Schnell-KI läuft",
        "ki_schnell_fertig": "Schnell-KI fertig",
        "ki_pruefung_offen": "Prüf-KI offen",
        "ki_pruefung_wartet": "Prüf-KI wartet",
        "ki_pruefung_laeuft": "Prüf-KI läuft",
        "ki_pruefung_fertig": "Prüf-KI fertig",
        "open": "Offen",
        "closed": "Abgeschlossen",
        "hochgeladen": "Hochgeladen",
    }
    return labels.get(str(value or ""), str(value or ""))


def label_role(value: Any) -> str:
    roles = {
        "Buchhaltung": "Spätere kaufmännische Auswertung",
        "Auswertung": "Spätere Auswertung",
        "Prüfer": "Prüfer",
        "Erfasser": "Erfasser",
        "Technik": "Technik",
    }
    return roles.get(str(value or ""), str(value or "Nicht zugeordnet"))


def label_field(value: Any) -> str:
    raw = str(value or "").strip()
    replacements = {
        "serial_number": "Seriennummer",
        "serial number": "Seriennummer",
        "seriennummer": "Seriennummer",
        "Seriennummer": "Seriennummer",
        "model": "Modell",
        "modell": "Modell",
        "Modell": "Modell",
        "Foto/Nachweis": "Foto oder Nachweisfoto",
        "Typenschildfoto": "Typenschildfoto",
        "object": "Objektfoto",
        "object_front": "Objektfoto",
        "object_back": "Rückseite/Detail",
        "type_plate": "Typenschild",
        "uvv_label": "UVV-Siegel",
        "condition_detail": "Zustandsdetail",
        "other": "Sonstiges Foto",
        "tire_overview": "Gesamtfoto Reifen/Radsatz",
        "tread": "Profilbild",
        "tire_size": "Reifengröße",
        "rim": "Felge",
        "damage": "Schaden",
        "dot_photo": "DOT-Foto",
        "dot": "DOT-Foto",
        "DOT-Foto": "DOT-Foto",
        "Anschaffungsdatum": "Anschaffungsdatum später klären",
        "Buchwert": "Wert später klären",
        "Anlagenummer": "Zuordnung später klären",
        "Anlagenummer/Buchwert": "Wert/Zuordnung später klären",
        "Wert/Zuordnung später klären": "Wert/Zuordnung später klären",
    }
    if raw in replacements:
        return replacements[raw]
    label = raw.replace("_", " ").strip()
    return f"{label[:1].upper()}{label[1:]}" if label else "offen"


def label_field_list(value: Any) -> str:
    parts = [part.strip() for part in str(value or "").split(",") if part.strip()]
    return ", ".join(label_field(part) for part in parts) if parts else ""


def export_value(row: dict[str, Any], key: str) -> Any:
    if key == "lfd_photo":
        return row.get("sequence_number") or row.get("inventory_id") or row.get("temporary_id") or ""
    if key == "function_ok_yes":
        return "X" if row.get("function_ok") == "ja" else ""
    if key == "function_ok_no":
        return "X" if row.get("function_ok") == "nein" else ""
    if key == "bga_remark":
        notes = [str(row.get("condition_note") or "").strip(), str(row.get("remark") or "").strip()]
        if row.get("function_ok") == "nicht_geprueft":
            notes.append("Funktion nicht geprüft")
        if row.get("uvv_status") in {"nicht_vorhanden", "unklar"}:
            notes.append(export_value(row, "uvv_status_label"))
        return " | ".join(note for note in notes if note)
    if key == "captured_by_name":
        return row.get("created_by_name") or row.get("session_started_by_name") or "Nicht erfasst"
    if key == "reviewed_by_name":
        return row.get("reviewed_by_name") or ("Prüfer nicht gesetzt" if row.get("manual_reviewed_at") else "")
    if key == "status_label":
        return label_status(row.get("status"))
    if key == "review_status_label":
        return label_status(row.get("review_status"))
    if key == "session_status_label":
        return label_status(row.get("session_status"))
    if key == "condition_label":
        return str(row.get("condition") or "").replace("_", " ")
    if key == "function_ok_label":
        return {
            "ja": "Ja",
            "nein": "Nein",
            "nicht_geprueft": "Nicht geprüft",
        }.get(str(row.get("function_ok") or ""), row.get("function_ok"))
    if key == "uvv_status_label":
        return {
            "vorhanden": "UVV vorhanden",
            "nicht_vorhanden": "UVV nicht vorhanden",
            "nicht_uvv_pflichtig": "nicht UVV-pflichtig",
            "unklar": "unklar",
        }.get(str(row.get("uvv_status") or ""), row.get("uvv_status"))
    if key == "uvv_valid_until":
        if row.get("uvv_valid_until"):
            return format_excel_datetime(row.get("uvv_valid_until"))
        if row.get("uvv_status") == "nicht_uvv_pflichtig":
            return "nicht UVV-pflichtig"
        if row.get("uvv_status") == "nicht_vorhanden":
            return "UVV nicht vorhanden"
        return ""
    if key == "inspection_book_label":
        return {
            "ja": "Ja",
            "nein": "Nein",
            "nicht_erforderlich": "Nicht erforderlich",
            "unklar": "Unklar",
        }.get(str(row.get("inspection_book_available") or ""), row.get("inspection_book_available"))
    if key == "type_plate_status_label":
        return {
            "vorhanden": "vorhanden",
            "nicht_vorhanden": "nicht vorhanden",
            "uebersprungen": "übersprungen",
            "nicht_geprueft": "nicht geprüft",
        }.get(str(row.get("type_plate_status") or ""), row.get("type_plate_status"))
    if key == "value_provenance":
        if row.get("latest_deep_dive_at") and row.get("value_estimate") is not None:
            return "KI-Schätzung, konservativ"
        return "Manuell/ungeklärt" if row.get("value_estimate") is not None else ""
    if key == "age_provenance":
        if row.get("latest_deep_dive_at") and row.get("estimated_age_years") is not None:
            return "KI-Altersschätzung, konservativ"
        if row.get("age_source") and row.get("age_source") != "unbekannt":
            return label_field(row.get("age_source"))
        return ""
    if key == "ai_value_note":
        if row.get("latest_deep_dive_at"):
            return "KI-Wert ist ein konservativer Richtwert und muss bei Bedarf fachlich bestätigt werden."
        return ""
    if key == "open_task_roles_label":
        return ", ".join(label_role(part.strip()) for part in str(row.get("open_task_roles") or "").split(",") if part.strip())
    if key == "open_task_fields_label":
        return label_field_list(row.get("open_task_fields"))
    if key in {
        "created_at",
        "updated_at",
        "finalized_at",
        "session_created_at",
        "session_started_at",
        "latest_ai_at",
        "latest_deep_dive_at",
        "manual_reviewed_at",
        "first_photo_uploaded_at",
        "last_photo_uploaded_at",
        "captured_at",
    }:
        return format_excel_datetime(row.get(key))
    value = row.get(key)
    if isinstance(value, bool):
        return "ja" if value else "nein"
    return value


def filename_part(value: str | None, fallback: str) -> str:
    raw = (value or fallback).strip().lower()
    cleaned = "".join(ch if ch.isalnum() else "-" for ch in raw)
    while "--" in cleaned:
        cleaned = cleaned.replace("--", "-")
    return cleaned.strip("-") or fallback


EXPORT_COLUMNS = [
    ("lfd. Nr. / Foto", "lfd_photo"),
    ("Bezeichnung", "object_type"),
    ("Typ / Spezifikation", "specification"),
    ("Baujahr", "construction_year"),
    ("Zustand", "condition_label"),
    ("Funktion i. O. Ja", "function_ok_yes"),
    ("Funktion i. O. Nein", "function_ok_no"),
    ("UVV bis", "uvv_valid_until"),
    ("Bemerkung", "bga_remark"),
]


def export_query(where_sql: str = "", params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    return fetch_all(
        f"""
        SELECT i.*, oc.name AS object_class_name,
          s.status AS session_status, s.created_at AS session_created_at,
          s.started_at AS session_started_at, s.closed_at AS session_closed_at,
          l.name AS location_name, b.name AS building_name, r.name AS room_name,
          session_starter.display_name AS session_started_by_name,
          creator.display_name AS created_by_name,
          reviewer.display_name AS reviewed_by_name,
          finalizer.display_name AS finalized_by_name,
          (
            SELECT ar.created_at
            FROM ai_results ar
            WHERE ar.item_id = i.id
            ORDER BY ar.created_at DESC
            LIMIT 1
          ) AS latest_ai_at,
          (
            SELECT ar.model_used
            FROM ai_results ar
            WHERE ar.item_id = i.id
            ORDER BY ar.created_at DESC
            LIMIT 1
          ) AS latest_ai_model,
          (
            SELECT ar.created_at
            FROM ai_results ar
            WHERE ar.item_id = i.id AND ar.ai_type = 'deep_dive'
            ORDER BY ar.created_at DESC
            LIMIT 1
          ) AS latest_deep_dive_at,
          (
            SELECT al.created_at
            FROM audit_log al
            WHERE al.entity_type = 'inventory_item'
              AND al.entity_id = i.id
              AND al.action IN ('item_changed', 'status_changed', 'item_finalized')
            ORDER BY al.created_at DESC
            LIMIT 1
          ) AS manual_reviewed_at,
          EXISTS(SELECT 1 FROM item_photos p WHERE p.item_id = i.id AND p.photo_type IN ('object','object_front')) AS has_object_photo,
          EXISTS(SELECT 1 FROM item_photos p WHERE p.item_id = i.id AND p.photo_type IN ('nameplate','type_plate')) AS has_nameplate_photo,
          EXISTS(SELECT 1 FROM item_photos p WHERE p.item_id = i.id AND p.photo_type = 'dot') AS has_dot_photo,
          (
            SELECT p.id
            FROM item_photos p
            WHERE p.item_id = i.id AND p.photo_type IN ('object','object_front')
            ORDER BY p.uploaded_at DESC
            LIMIT 1
          ) AS object_photo_id,
          (
            SELECT COALESCE(p.original_path, p.stamped_path)
            FROM item_photos p
            WHERE p.item_id = i.id AND p.photo_type IN ('object','object_front')
            ORDER BY p.uploaded_at DESC
            LIMIT 1
          ) AS object_photo_path,
          (SELECT min(p.uploaded_at) FROM item_photos p WHERE p.item_id = i.id) AS first_photo_uploaded_at,
          (SELECT max(p.uploaded_at) FROM item_photos p WHERE p.item_id = i.id) AS last_photo_uploaded_at,
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
        LEFT JOIN users session_starter ON session_starter.id = s.started_by
        LEFT JOIN users creator ON creator.id = i.created_by
        LEFT JOIN users reviewer ON reviewer.id = i.reviewed_by
        LEFT JOIN users finalizer ON finalizer.id = i.finalized_by
        {where_sql}
        ORDER BY l.name, b.name, r.name, i.created_at DESC
        """,
        params,
    )


def refreshed_export_rows(where_sql: str = "", params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    rows = export_query(where_sql, params)
    refreshed = False
    for row in rows:
        if row.get("id") and row.get("inventory_type") == "bga":
            run_inventory_rework_check(str(row["id"]))
            refreshed = True
    rows = export_query(where_sql, params) if refreshed else rows
    return normalize_export_open_tasks(rows)


def bga_task_satisfied_by_item(task: dict[str, Any], item: dict[str, Any]) -> bool:
    if item.get("inventory_type") != "bga":
        return False
    field = label_field(task.get("missing_field")).lower()
    function_resolved = item.get("function_ok") == "ja"
    uvv_resolved = item.get("uvv_status") in {"vorhanden", "nicht_uvv_pflichtig"}
    inspection_book_resolved = item.get("inspection_book_available") in {"ja", "nein", "nicht_erforderlich"}
    if "funktion" in field and "uvv" in field:
        return function_resolved and uvv_resolved
    if "funktion" in field:
        return function_resolved
    if "uvv" in field:
        return uvv_resolved
    if "prüfbuch" in field or "pruefbuch" in field:
        return inspection_book_resolved
    return False


def export_task_relevant(task: dict[str, Any], item: dict[str, Any]) -> bool:
    if bga_task_satisfied_by_item(task, item):
        return False
    if item.get("inventory_type") == "bga" and "prüfbuch" in label_field(task.get("missing_field")).lower():
        return False
    return True


def normalize_export_open_tasks(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for item in rows:
        if not item.get("id"):
            continue
        item_tasks = fetch_all(
            """
            SELECT *
            FROM accounting_tasks
            WHERE item_id = %s AND status = 'open'
            ORDER BY created_at
            """,
            (item["id"],),
        )
        relevant = [task for task in item_tasks if export_task_relevant(task, item)]
        item["open_task_count"] = len(relevant)
        roles = sorted({str(task.get("assigned_role") or "") for task in relevant if task.get("assigned_role")})
        item["open_task_roles"] = ", ".join(roles)
        item["open_task_fields"] = ", ".join(str(task.get("missing_field") or "") for task in relevant if task.get("missing_field"))
    return rows


def task_action(role: str | None, field: str | None) -> str:
    role_label = label_role(role)
    field_label = label_field(field)
    if role in {"Buchhaltung", "Auswertung"}:
        return f"{field_label} nach der Raumaufnahme auswerten"
    if role == "Erfasser":
        return f"{field_label} im Raum ergänzen"
    if role == "Technik":
        return f"{field_label} technisch prüfen"
    return f"{field_label} für {role_label} prüfen"


def task_reason(role: str | None) -> str:
    if role in {"Buchhaltung", "Auswertung"}:
        return "Blockiert die schnelle Erfassung nicht; dient der späteren Auswertung."
    if role == "Erfasser":
        return "Fehlt für belastbaren Foto-/Objektnachweis im Raum."
    if role == "Technik":
        return "Technischer Nachweis oder Prüffrist ist noch offen."
    return "Punkt ist für saubere Prüfung noch offen."


def fetch_export_tasks(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    for item in rows:
        if not item.get("id"):
            continue
        item_tasks = fetch_all(
            """
            SELECT *
            FROM accounting_tasks
            WHERE item_id = %s AND status = 'open'
            ORDER BY created_at
            """,
            (item["id"],),
        )
        for task in item_tasks:
            if not export_task_relevant(task, item):
                continue
            if item.get("inventory_type") == "bga" and "prüfbuch" in label_field(task.get("missing_field")).lower():
                continue
            task["item"] = item
            tasks.append(task)
    return tasks


def fetch_export_photos(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    photos: list[dict[str, Any]] = []
    for item in rows:
        if not item.get("id"):
            continue
        item_photos = fetch_all(
            """
            SELECT id, photo_type, original_path, stamped_path, uploaded_at, taken_at
            FROM item_photos
            WHERE item_id = %s
            ORDER BY uploaded_at ASC
            """,
            (item["id"],),
        )
        for photo in item_photos:
            photo["item"] = item
            photos.append(photo)
    return photos


def fetch_export_audit_rows(rows: list[dict[str, Any]], session_id: str | None, entity_id: str | None) -> list[dict[str, Any]]:
    ids = [str(row["id"]) for row in rows if row.get("id")]
    if session_id:
        ids.append(session_id)
    elif entity_id:
        ids.append(entity_id)
    audit_rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row_id in ids:
        if row_id in seen:
            continue
        seen.add(row_id)
        audit_rows.extend(fetch_all("SELECT * FROM audit_log WHERE entity_id = %s ORDER BY created_at ASC", (row_id,)))
    return sorted(audit_rows, key=lambda row: row.get("created_at") or datetime.min)


EXCEL_DETAIL_PHOTO_TYPES = {"type_plate", "nameplate", "uvv_label", "condition_detail", "dot", "tread", "tire_size", "damage"}


def excel_photo_limit(photo_type: Any) -> int:
    return 2400 if str(photo_type or "") in EXCEL_DETAIL_PHOTO_TYPES else 1600


def excel_photo_source(photo: dict[str, Any]) -> Path | None:
    raw_path = photo.get("original_path") or photo.get("stamped_path")
    if not raw_path:
        return None
    try:
        path = safe_upload_path(str(raw_path))
    except HTTPException:
        return None
    return path if path.exists() else None


def prepare_excel_photo(photo: dict[str, Any]) -> tuple[Path | None, int | None, int | None, str]:
    source = excel_photo_source(photo)
    if not source:
        return None, None, None, "Original fehlt"
    limit = excel_photo_limit(photo.get("photo_type"))
    digest = hashlib.sha256(f"{source}-{source.stat().st_mtime_ns}-{limit}".encode("utf-8")).hexdigest()[:16]
    target = Path(settings.upload_root, "temp", f"excel-{digest}.jpg")
    try:
        if target.exists():
            with PillowImage.open(target) as cached:
                return target, cached.width, cached.height, "Original für Excel optimiert"
        with PillowImage.open(source) as image:
            image = ImageOps.exif_transpose(image)
            image.thumbnail((limit, limit), PillowImage.Resampling.LANCZOS)
            if image.mode not in {"RGB", "L"}:
                image = image.convert("RGB")
            target.parent.mkdir(parents=True, exist_ok=True)
            image.save(target, format="JPEG", quality=90, optimize=True)
            return target, image.width, image.height, "Original für Excel optimiert"
    except Exception:
        return source, None, None, "Original unverändert eingebettet"


def audit_action_label(action: Any) -> str:
    labels = {
        "session_started": "Raum-Session gestartet",
        "device_joined": "Handy gekoppelt",
        "item_created": "Gegenstand angelegt",
        "photo_uploaded": "Foto hochgeladen",
        "audio_saved": "Sprachnotiz gespeichert",
        "ai_job_queued": "KI gestartet",
        "ai_result_created": "KI-Vorschlag erstellt",
        "ai_deep_dive_created": "KI Deep Dive erstellt",
        "item_changed": "Gegenstand manuell geändert",
        "status_changed": "Status geändert",
        "rework_requested": "Nacharbeit gesetzt",
        "item_finalized": "Gegenstand finalisiert",
        "session_closed": "Raum abgeschlossen",
        "export_created": "Excel-Export erstellt",
    }
    return labels.get(str(action or ""), str(action or ""))


def build_excel_workbook(
    title: str,
    rows: list[dict[str, Any]],
    summary: dict[str, Any],
    session_id: str | None = None,
    entity_id: str | None = None,
) -> Workbook:
    wb = Workbook()
    ws = wb.active
    ws.title = "Inventurliste"
    header_fill = PatternFill("solid", fgColor="D9E2D6")
    thin_side = Side(style="thin", color="6B7280")
    list_border = Border(left=thin_side, right=thin_side, top=thin_side, bottom=thin_side)

    ws.merge_cells("A1:I1")
    ws["A1"] = "Manuelle Zählliste"
    ws["A1"].font = Font(bold=True, size=18)
    ws["A1"].alignment = Alignment(horizontal="center")
    ws.merge_cells("A2:I2")
    ws["A2"] = "Betriebs- und Geschäftsausstattung"
    ws["A2"].font = Font(bold=True, size=14)
    ws["A2"].alignment = Alignment(horizontal="center")

    captured_by = next((export_value(row, "captured_by_name") for row in rows if row.get("id")), summary.get("erfasst durch") or summary.get("Aufnehmer") or "")
    captured_at = summary.get("Datum") or summary.get("Erstes Objekt aufgenommen am") or format_excel_datetime(datetime.now())
    ws["A4"] = "Standort"
    ws["B4"] = " / ".join(str(part) for part in [summary.get("Betrieb"), summary.get("Gebäude"), summary.get("Raum")] if part)
    ws["D4"] = "erfasst durch"
    ws["E4"] = captured_by
    ws["G4"] = "Datum"
    ws["H4"] = captured_at
    for cell_ref in ["A4", "D4", "G4"]:
        ws[cell_ref].font = Font(bold=True)

    header_row = 7
    for column_index, (header, _) in enumerate(EXPORT_COLUMNS, start=1):
        cell = ws.cell(row=header_row, column=column_index, value=header)
        cell.font = Font(bold=True)
        cell.fill = header_fill
        cell.border = list_border
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)

    for row_index, row in enumerate(rows, start=header_row + 1):
        ws.append([excel_value(export_value(row, key)) for _, key in EXPORT_COLUMNS])
        insert_excel_photo(ws, row, row_index)
        for column_index, (_, key) in enumerate(EXPORT_COLUMNS, start=1):
            if key in {"value_provenance", "age_provenance", "ai_value_note", "latest_ai_at", "latest_deep_dive_at", "latest_ai_model"}:
                ws.cell(row=row_index, column=column_index).fill = PatternFill("solid", fgColor="D9EAFE")
            cell = ws.cell(row=row_index, column=column_index)
            cell.border = list_border
            cell.alignment = Alignment(vertical="top", wrap_text=True)
        ws.row_dimensions[row_index].height = max(ws.row_dimensions[row_index].height or 0, 46)

    ws.freeze_panes = "A8"
    if rows:
        ws.auto_filter.ref = f"A{header_row}:I{header_row + len(rows)}"
    ws.print_title_rows = "1:7"
    ws.print_area = f"A1:I{max(header_row + len(rows), header_row + 1)}"
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.orientation = "landscape"
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.page_margins.left = 0.25
    ws.page_margins.right = 0.25
    ws.page_margins.top = 0.5
    ws.page_margins.bottom = 0.5
    widths = [18, 28, 34, 12, 16, 16, 16, 16, 48]
    for index, width in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(index)].width = width

    summary_ws = wb.create_sheet("Übersicht", 0)
    summary_ws.append(["Export", title])
    summary_ws.append(["Erzeugt am", excel_value(datetime.now())])
    for key, value in summary.items():
        summary_ws.append([key, excel_value(value)])
    summary_ws["A1"].font = Font(bold=True)
    summary_ws["B1"].font = Font(bold=True)
    summary_ws.column_dimensions["A"].width = 24
    summary_ws.column_dimensions["B"].width = 42

    task_ws = wb.create_sheet("Offene Punkte - Nacharbeit")
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

    if "Offene Punkte - Nacharbeit" in wb.sheetnames:
        del wb["Offene Punkte - Nacharbeit"]
    task_ws = wb.create_sheet("Offene Punkte - Nacharbeit")
    task_ws.append([
        "Priorität", "Inventar-ID", "Objekt", "Klasse", "Raum", "Verantwortlich",
        "Aufgabe", "Warum relevant", "Blockiert Finalisierung", "Status", "Erstellt am", "Erledigt am", "Hinweis"
    ])
    for task in fetch_export_tasks(rows):
        item = task["item"]
        role = task.get("assigned_role")
        field = task.get("missing_field")
        blocks = "ja" if role in {"Erfasser", "Prüfer", "Technik"} else "nein"
        task_ws.append([
            task.get("priority") or "normal",
            item.get("inventory_id") or item.get("temporary_id"),
            item.get("object_type") or "Unbekanntes Objekt",
            item.get("object_class_name"),
            item.get("room_name"),
            label_role(role),
            task_action(role, field),
            task_reason(role),
            blocks,
            label_status(task.get("status")),
            format_excel_datetime(task.get("created_at")),
            format_excel_datetime(task.get("completed_at")),
            task.get("comment") or "",
        ])
    task_ws.freeze_panes = "A2"
    task_ws.auto_filter.ref = task_ws.dimensions
    for index in range(1, 14):
        task_ws.column_dimensions[get_column_letter(index)].width = 24

    photos_ws = wb.create_sheet("Fotos - Nachweise")
    photos_ws.append([
        "Bild", "Objekt-ID", "Laufende Nr.", "Objekt", "Fotoart", "Dateiname",
        "Original-Link/Pfad", "Excel-Bildquelle", "Pixel", "Aufgenommen am", "Hochgeladen am"
    ])
    for row_index, photo in enumerate(fetch_export_photos(rows), start=2):
        item = photo["item"]
        source_path = excel_photo_source(photo)
        image_path, width, height, source_note = prepare_excel_photo(photo)
        photos_ws.append([
            " ",
            item.get("inventory_id") or item.get("temporary_id"),
            item.get("sequence_number"),
            item.get("object_type"),
            label_field(photo.get("photo_type")),
            source_path.name if source_path else "",
            str(source_path) if source_path else "",
            source_note,
            f"{width} x {height}" if width and height else "",
            format_excel_datetime(photo.get("taken_at")),
            format_excel_datetime(photo.get("uploaded_at")),
        ])
        if source_path:
            link_cell = photos_ws.cell(row=row_index, column=7)
            link_cell.hyperlink = f"/uploads/photos/{photo['id']}"
            link_cell.style = "Hyperlink"
        if image_path and image_path.exists():
            try:
                image = ExcelImage(str(image_path))
                max_width, max_height = 300, 210
                scale = min(max_width / image.width, max_height / image.height, 1)
                image.width = int(image.width * scale)
                image.height = int(image.height * scale)
                image.anchor = f"A{row_index}"
                photos_ws.add_image(image)
                photos_ws.row_dimensions[row_index].height = 168
            except Exception:
                photos_ws.cell(row=row_index, column=1, value="Bild nicht lesbar")
    photos_ws.freeze_panes = "A2"
    photos_ws.auto_filter.ref = photos_ws.dimensions
    for index, width in enumerate([34, 24, 12, 28, 18, 36, 72, 28, 18, 22, 22], start=1):
        photos_ws.column_dimensions[get_column_letter(index)].width = width

    protocol_ws = wb.create_sheet("Protokoll")
    protocol_ws.append(["Zeitpunkt", "Aktion", "Entität", "Benutzer", "Details"])
    for audit_row in fetch_export_audit_rows(rows, session_id, entity_id):
        protocol_ws.append([
            format_excel_datetime(audit_row.get("created_at")),
            audit_action_label(audit_row.get("action")),
            audit_row.get("entity_type"),
            audit_row.get("user_id") or "",
            str(audit_row.get("new_value_json") or "")[:500],
        ])
    protocol_ws.freeze_panes = "A2"
    protocol_ws.auto_filter.ref = protocol_ws.dimensions
    for index, width in enumerate([22, 28, 22, 24, 80], start=1):
        protocol_ws.column_dimensions[get_column_letter(index)].width = width

    return wb


def insert_excel_photo(ws: Any, row: dict[str, Any], row_index: int) -> None:
    cell = ws.cell(row=row_index, column=1)
    current_value = cell.value
    photo_path = row.get("object_photo_path")
    if not photo_path:
        return
    path = Path(str(photo_path))
    if not path.exists():
        cell.value = f"{current_value or ''} / Foto fehlt".strip()
        return
    try:
        image_path, _, _, _ = prepare_excel_photo({"original_path": str(path), "photo_type": "object_front"})
        image = ExcelImage(str(image_path or path))
    except Exception:
        cell.value = f"{current_value or ''} / Foto nicht lesbar".strip()
        return

    max_side = 82
    scale = min(max_side / image.width, max_side / image.height, 1)
    image.width = int(image.width * scale)
    image.height = int(image.height * scale)
    image.anchor = f"A{row_index}"
    ws.add_image(image)
    ws.row_dimensions[row_index].height = 68
    cell.value = current_value
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
    wb = build_excel_workbook(title, rows, summary, session_id=session_id, entity_id=entity_id)
    wb.save(path)
    export = execute(
        "INSERT INTO exports (tenant_id, session_id, export_type, file_path) VALUES ((SELECT tenant_id FROM inventory_sessions WHERE id = %s), %s, %s, %s) RETURNING *",
        (session_id, session_id, export_type, str(path)),
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
    session_inventory_type = session.get("inventory_type") or "bga"
    if session_inventory_type != "bga":
        raise HTTPException(
            status_code=409,
            detail=f"Excel-Export für {inventory_type_label(session_inventory_type)} ist vorbereitet, aber noch nicht aktiv.",
        )
    rows = refreshed_export_rows("WHERE i.session_id = %s", (session_id,))
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
            "Aufnehmer": rows[0].get("session_started_by_name") if rows else None,
            "Session gestartet am": format_excel_datetime(session.get("started_at") or session.get("created_at")),
            "Erstes Objekt aufgenommen am": format_excel_datetime(min((row.get("created_at") for row in rows if row.get("created_at")), default=None)),
            "Letzte Änderung am": format_excel_datetime(max((row.get("updated_at") for row in rows if row.get("updated_at")), default=None)),
            "Prüfer": "siehe Inventur-Spalten Prüfer und Manuell geprüft am",
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
        "INSERT INTO exports (tenant_id, session_id, file_path) VALUES ((SELECT tenant_id FROM inventory_sessions WHERE id = %s), %s, %s) RETURNING *",
        (session_id, session_id, str(path)),
    )
    audit("export_created", "inventory_session", session_id, export)
    return export


@app.post("/items/{item_id}/export/excel")
def export_item_excel(item_id: str) -> dict[str, Any]:
    item = get_item(item_id)
    rows = refreshed_export_rows("WHERE i.id = %s", (item_id,))
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
    rows = refreshed_export_rows()
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
def download_photo(photo_id: str, request: Request) -> FileResponse:
    row = fetch_one(
        """
        SELECT p.*, i.session_id
        FROM item_photos p
        JOIN inventory_items i ON i.id = p.item_id
        WHERE p.id = %s
        """,
        (photo_id,),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Foto nicht gefunden")
    auth = getattr(request.state, "auth", {}) or {}
    if auth.get("kind") == "mobile_session" and str(row.get("session_id")) != str(auth.get("session_id")):
        raise HTTPException(status_code=403, detail="Foto gehört nicht zu dieser mobilen Session")
    if auth.get("tenant_id") and row.get("tenant_id") and str(row.get("tenant_id")) != str(auth.get("tenant_id")):
        raise HTTPException(status_code=403, detail="Foto gehört nicht zu diesem Mandanten")
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
