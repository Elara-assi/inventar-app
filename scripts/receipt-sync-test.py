#!/usr/bin/env python3
from __future__ import annotations

import os
import subprocess
import sys
import uuid

import requests


API = os.environ.get("INVENTAR_API", "http://127.0.0.1:8000")
EMAIL = os.environ.get("INVENTAR_TEST_EMAIL", "pruefer@example.local")
PASSWORD = os.environ.get("INVENTAR_TEST_PASSWORD", "demo")
UPLOAD_HOST_ROOT = os.environ.get("INVENTAR_UPLOAD_HOST_ROOT", "/opt/stacks/inventar-app/storage/uploads")


def post(path: str, token: str | None = None, **kwargs):
    headers = kwargs.pop("headers", {})
    if token:
        headers["Authorization"] = f"Bearer {token}"
    response = requests.post(f"{API}{path}", headers=headers, timeout=30, **kwargs)
    response.raise_for_status()
    return response


def get(path: str, token: str | None = None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    response = requests.get(f"{API}{path}", headers=headers, timeout=30)
    response.raise_for_status()
    return response


def host_upload_path(container_path: str) -> str:
    return container_path.replace("/opt/inventar/uploads", UPLOAD_HOST_ROOT)


def main() -> int:
    run = str(uuid.uuid4())[:8]
    source_device_id = f"device-receipt-{run}"
    client_item_id = f"client-item-{run}"
    photo_ids = [f"client-photo-{run}-1", f"client-photo-{run}-2"]
    print("RUN", run)

    login = post("/auth/login", json={"email": EMAIL, "password": PASSWORD}).json()
    user_token = login["access_token"]

    session = post(
        "/sessions",
        token=user_token,
        json={
            "location_name": f"Receipt Test {run}",
            "building_name": "Sync Gebaeude",
            "room_name": f"Raum {run}",
            "inventory_type": "bga",
        },
    ).json()
    session_id = session["id"]
    print("SESSION", session_id)

    joined = post(
        "/sessions/join",
        json={"token": session["join_token"], "device_name": "Receipt Sync Test", "device_fingerprint": source_device_id},
    ).json()
    mobile_token = joined["access_token"]

    item_payload = {
        "session_id": session_id,
        "inventory_type": "bga",
        "client_item_id": client_item_id,
        "source_device_id": source_device_id,
        "object_type": "Receipt Sync Test",
        "specification": "Objekt mit zwei Fotos",
        "condition": "gebraucht",
        "function_ok": "ja",
        "uvv_status": "nicht_uvv_pflichtig",
        "inspection_book_available": "nicht_erforderlich",
        "remark": "Automatischer Receipt-Test",
    }
    item = post("/items", token=mobile_token, json=item_payload).json()
    print("ITEM", item["id"], item.get("client_item_id"), item.get("source_device_id"))

    contents = [b"\xff\xd8\xff receipt-test-1", b"\xff\xd8\xff receipt-test-2"]
    for idx, client_photo_id in enumerate(photo_ids):
        response = post(
            "/offline-sync/photos",
            token=mobile_token,
            data={
                "session_id": session_id,
                "source_device_id": source_device_id,
                "client_item_id": client_item_id,
                "client_photo_id": client_photo_id,
                "photo_type": "object_front" if idx == 0 else "type_plate",
            },
            files={"file": (f"{client_photo_id}.jpg", contents[idx], "image/jpeg")},
        )
        print("PHOTO_RESP", idx + 1, response.status_code, response.text)

    items = get(f"/sessions/{session_id}/items", token=user_token).json()
    server_item = next(entry for entry in items if entry["id"] == item["id"])
    print("SESSION_ITEM_PHOTOS", len(server_item.get("photos", [])))

    status = get(
        f"/offline-sync/status?session_id={session_id}&source_device_id={source_device_id}&client_item_id={client_item_id}&client_photo_ids={','.join(photo_ids)}",
        token=mobile_token,
    ).json()
    print("SYNC_STATUS", status)
    if status.get("server_item_id") != item["id"]:
        raise SystemExit(f"status did not resolve server item: {status}")
    if sorted(status.get("known_client_photo_ids", [])) != sorted(photo_ids):
        raise SystemExit(f"status did not confirm all photos: {status}")
    if status.get("missing_client_photo_ids"):
        raise SystemExit(f"status reported missing photos: {status}")

    missing_probe_id = f"client-photo-receipt-{run}-missing"
    missing_status = get(
        f"/offline-sync/status?session_id={session_id}&source_device_id={source_device_id}&client_item_id={client_item_id}&client_photo_ids={photo_ids[0]},{missing_probe_id}",
        token=mobile_token,
    ).json()
    print("SYNC_STATUS_MISSING_PROBE", missing_status)
    if missing_status.get("known_client_photo_ids") != [photo_ids[0]]:
        raise SystemExit(f"status missing probe did not keep known photo only: {missing_status}")
    if missing_status.get("missing_client_photo_ids") != [missing_probe_id]:
        raise SystemExit(f"status missing probe did not report missing photo: {missing_status}")

    for idx, client_photo_id in enumerate(photo_ids):
        response = post(
            "/offline-sync/photos",
            token=mobile_token,
            data={
                "session_id": session_id,
                "source_device_id": source_device_id,
                "client_item_id": client_item_id,
                "client_photo_id": client_photo_id,
                "photo_type": "object_front" if idx == 0 else "type_plate",
            },
            files={"file": (f"{client_photo_id}.jpg", contents[idx], "image/jpeg")},
        )
        print("DUP_RESP", idx + 1, response.status_code, response.text)

    items_after = get(f"/sessions/{session_id}/items", token=user_token).json()
    server_item_after = next(entry for entry in items_after if entry["id"] == item["id"])
    if len(server_item_after.get("photos", [])) != 2:
        raise SystemExit("duplicate/idempotency failed")

    query = f"SELECT id, photo_type, client_photo_id, original_path FROM item_photos WHERE item_id = '{item['id']}' ORDER BY id;"
    db = subprocess.check_output(
        ["docker", "compose", "exec", "-T", "postgres", "psql", "-U", "inventar", "-d", "inventar", "-t", "-A", "-F", "|", "-c", query],
        text=True,
    )
    print("DB_ROWS")
    print(db)
    paths = [line.split("|")[3] for line in db.strip().splitlines() if len(line.split("|")) >= 4]
    if len(paths) != 2:
        raise SystemExit(f"expected 2 DB photo rows, got {len(paths)}")
    for path in paths:
        host_path = host_upload_path(path)
        print("FILE_EXISTS", host_path, os.path.exists(host_path), os.path.getsize(host_path) if os.path.exists(host_path) else None)
        if not os.path.exists(host_path):
            raise SystemExit(f"missing file {host_path}")

    requests.delete(f"{API}/sessions/{session_id}", headers={"Authorization": f"Bearer {user_token}"}, timeout=30)
    for path in paths:
        host_path = host_upload_path(path)
        stamped_path = host_path.replace("/originals/", "/stamped/")
        for cleanup_path in [host_path, stamped_path]:
            if os.path.exists(cleanup_path):
                os.remove(cleanup_path)
    print("OK receipt photo sync proven")
    return 0


if __name__ == "__main__":
    sys.exit(main())
