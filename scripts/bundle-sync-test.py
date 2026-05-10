#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
import uuid

import requests


API = os.environ.get("INVENTAR_API", "http://127.0.0.1:8000")
EMAIL = os.environ.get("INVENTAR_TEST_EMAIL", "pruefer@example.local")
PASSWORD = os.environ.get("INVENTAR_TEST_PASSWORD", "demo")


def post(path: str, token: str | None = None, **kwargs):
    headers = kwargs.pop("headers", {})
    if token:
        headers["Authorization"] = f"Bearer {token}"
    response = requests.post(f"{API}{path}", headers=headers, timeout=45, **kwargs)
    response.raise_for_status()
    return response


def get(path: str, token: str | None = None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    response = requests.get(f"{API}{path}", headers=headers, timeout=30)
    response.raise_for_status()
    return response


def db_query(sql: str) -> str:
    return subprocess.check_output(
        ["docker", "compose", "exec", "-T", "postgres", "psql", "-U", "inventar", "-d", "inventar", "-t", "-A", "-F", "|", "-c", sql],
        text=True,
    )


def main() -> int:
    run = str(uuid.uuid4())[:8]
    source_device_id = f"device-bundle-{run}"
    client_item_id = f"client-item-bundle-{run}"
    photo_ids = [f"client-photo-bundle-{run}-1", f"client-photo-bundle-{run}-2"]
    print("RUN", run)

    login = post("/auth/login", json={"email": EMAIL, "password": PASSWORD}).json()
    user_token = login["access_token"]

    session = post(
        "/sessions",
        token=user_token,
        json={
            "captured_by": "Bundle Sync Test",
            "location_name": f"Bundle Test {run}",
            "building_name": "Sync Gebaeude",
            "room_name": f"Raum {run}",
            "inventory_type": "bga",
        },
    ).json()
    session_id = session["id"]
    print("SESSION", session_id)

    joined = post(
        "/sessions/join",
        json={
            "token": session["join_token"],
            "device_name": "Bundle Sync Test",
            "device_fingerprint": source_device_id,
        },
    ).json()
    mobile_token = joined["access_token"]

    payload = {
        "item": {
            "session_id": session_id,
            "inventory_type": "bga",
            "client_item_id": client_item_id,
            "source_device_id": source_device_id,
            "object_type": "Bundle Sync Test Objekt",
            "specification": "Objektpaket mit zwei Fotos",
            "condition": "gebraucht",
            "function_ok": "ja",
            "uvv_status": "nicht_uvv_pflichtig",
            "inspection_book_available": "nicht_erforderlich",
            "remark": "Automatischer Bundle-Sync-Test",
            "type_plate_status": "vorhanden",
        },
        "photos": [
            {
                "client_photo_id": photo_ids[0],
                "photo_type": "object_front",
                "filename": f"{photo_ids[0]}.jpg",
                "mime_type": "image/jpeg",
            },
            {
                "client_photo_id": photo_ids[1],
                "photo_type": "type_plate",
                "filename": f"{photo_ids[1]}.jpg",
                "mime_type": "image/jpeg",
            },
        ],
    }
    contents = [b"\xff\xd8\xff bundle-test-1", b"\xff\xd8\xff bundle-test-2"]
    files = [
        ("files", (f"{photo_ids[0]}.jpg", contents[0], "image/jpeg")),
        ("files", (f"{photo_ids[1]}.jpg", contents[1], "image/jpeg")),
    ]

    response = post(
        "/offline-sync/items",
        token=mobile_token,
        data={"payload": json.dumps(payload)},
        files=files,
    )
    print("BUNDLE_RESP", response.status_code, response.text)
    bundle = response.json()
    item_id = bundle["server_item_id"]
    photo_results = bundle.get("photo_results", [])
    if len(photo_results) != 2 or any(result.get("status") not in {"synced", "already_exists"} for result in photo_results):
        raise SystemExit(f"bundle photos not confirmed: {photo_results}")

    items = get(f"/sessions/{session_id}/items", token=user_token).json()
    server_item = next(entry for entry in items if entry["id"] == item_id)
    print("SESSION_ITEM_PHOTOS", len(server_item.get("photos", [])))
    if len(server_item.get("photos", [])) != 2:
        raise SystemExit("GET /sessions/{id}/items did not return both photos")

    duplicate = post(
        "/offline-sync/items",
        token=mobile_token,
        data={"payload": json.dumps(payload)},
        files=[
            ("files", (f"{photo_ids[0]}.jpg", contents[0], "image/jpeg")),
            ("files", (f"{photo_ids[1]}.jpg", contents[1], "image/jpeg")),
        ],
    ).json()
    print("BUNDLE_DUP_RESP", json.dumps(duplicate, ensure_ascii=False))
    dup_results = duplicate.get("photo_results", [])
    if len(dup_results) != 2 or any(result.get("status") != "already_exists" for result in dup_results):
        raise SystemExit(f"bundle idempotency failed: {dup_results}")

    rows = db_query(f"SELECT id, photo_type, client_photo_id, original_path FROM item_photos WHERE item_id = '{item_id}' ORDER BY id;")
    print("DB_ROWS")
    print(rows)
    parsed_rows = [line.split("|") for line in rows.strip().splitlines() if line.strip()]
    if len(parsed_rows) != 2:
        raise SystemExit(f"expected 2 DB photo rows, got {len(parsed_rows)}")

    for row in parsed_rows:
        host_path = row[3].replace("/opt/inventar/uploads", "/opt/stacks/inventar-app/storage/uploads")
        exists = os.path.exists(host_path)
        size = os.path.getsize(host_path) if exists else None
        print("FILE_EXISTS", host_path, exists, size)
        if not exists or not size:
            raise SystemExit(f"missing physical photo file {host_path}")

    requests.delete(f"{API}/sessions/{session_id}", headers={"Authorization": f"Bearer {user_token}"}, timeout=30)
    for row in parsed_rows:
        host_path = row[3].replace("/opt/inventar/uploads", "/opt/stacks/inventar-app/storage/uploads")
        stamped_path = host_path.replace("/originals/", "/stamped/")
        for cleanup_path in [host_path, stamped_path]:
            if os.path.exists(cleanup_path):
                os.remove(cleanup_path)

    print("OK bundled item photo sync proven")
    return 0


if __name__ == "__main__":
    sys.exit(main())
