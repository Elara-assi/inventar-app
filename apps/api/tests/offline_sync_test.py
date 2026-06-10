from fastapi.testclient import TestClient

from app import main


def test_offline_sync_status_reports_known_and_missing_photos(monkeypatch):
    session = {"id": "session-1", "status": "open", "inventory_type": "bga"}
    item = {
        "id": "item-1",
        "session_id": "session-1",
        "source_device_id": "device-1",
        "client_item_id": "client-item-1",
        "object_type": "Scanner Objekt",
        "sequence_number": 7,
        "status": "erfasst",
        "review_status": "offen",
    }
    photos = [
        {"id": "photo-1", "item_id": "item-1", "photo_type": "object_front", "client_photo_id": "photo-a", "original_path": "/uploads/a.jpg", "uploaded_at": "2026-06-09T08:00:00Z"},
        {"id": "photo-2", "item_id": "item-1", "photo_type": "type_plate", "client_photo_id": "photo-b", "original_path": "/uploads/b.jpg", "uploaded_at": "2026-06-09T08:01:00Z"},
    ]

    def fake_decode_access_token(_token):
        return {"kind": "mobile_session", "session_id": "session-1", "device_id": "device-row-1"}

    def fake_fetch_one(sql, params=()):
        if "FROM session_devices" in sql:
            return {"id": "device-row-1", "session_id": "session-1", "revoked_at": None}
        if "FROM inventory_sessions" in sql:
            return session
        if "FROM inventory_items" in sql:
            return item
        return None

    def fake_fetch_all(sql, params=()):
        if "FROM item_photos" in sql:
            return photos
        return []

    monkeypatch.setattr(main, "decode_access_token", fake_decode_access_token)
    monkeypatch.setattr(main, "fetch_one", fake_fetch_one)
    monkeypatch.setattr(main, "fetch_all", fake_fetch_all)

    client = TestClient(main.app)
    response = client.get(
        "/offline-sync/status?session_id=session-1&source_device_id=device-1&client_item_id=client-item-1&client_photo_ids=photo-a,photo-b,photo-c",
        headers={"Authorization": "Bearer mobile-token"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["server_item_id"] == "item-1"
    assert payload["item_status"] == "synced"
    assert payload["known_client_photo_ids"] == ["photo-a", "photo-b"]
    assert payload["missing_client_photo_ids"] == ["photo-c"]

    missing_probe = client.get(
        "/offline-sync/status?session_id=session-1&source_device_id=device-1&client_item_id=client-item-1&client_photo_ids=photo-a,photo-c",
        headers={"Authorization": "Bearer mobile-token"},
    )
    assert missing_probe.status_code == 200
    missing_payload = missing_probe.json()
    assert missing_payload["known_client_photo_ids"] == ["photo-a"]
    assert missing_payload["missing_client_photo_ids"] == ["photo-c"]


def test_offline_sync_status_rejects_other_mobile_session(monkeypatch):
    def fake_decode_access_token(_token):
        return {"kind": "mobile_session", "session_id": "session-2", "device_id": "device-row-2"}

    def fake_fetch_one(sql, params=()):
        if "FROM session_devices" in sql:
            return {"id": "device-row-2", "session_id": "session-2", "revoked_at": None}
        return None

    monkeypatch.setattr(main, "decode_access_token", fake_decode_access_token)
    monkeypatch.setattr(main, "fetch_one", fake_fetch_one)

    client = TestClient(main.app)
    response = client.get(
        "/offline-sync/status?session_id=session-1&source_device_id=device-1&client_item_id=client-item-1",
        headers={"Authorization": "Bearer mobile-token"},
    )

    assert response.status_code == 403
    assert "Sync-Status" in response.json()["detail"]


def test_offline_sync_reconcile_classifies_synced_missing_and_closed(monkeypatch):
    session = {"id": "session-1", "status": "open", "inventory_type": "bga"}
    item = {
        "id": "item-1",
        "session_id": "session-1",
        "source_device_id": "device-1",
        "client_item_id": "client-item-1",
        "object_type": "Scanner Objekt",
        "sequence_number": 7,
        "status": "erfasst",
        "review_status": "offen",
    }
    photos = [
        {"id": "photo-1", "item_id": "item-1", "photo_type": "object_front", "client_photo_id": "photo-a", "original_path": "/uploads/a.jpg", "uploaded_at": "2026-06-09T08:00:00Z"},
    ]

    def fake_decode_access_token(_token):
        return {"kind": "mobile_session", "session_id": "session-1", "device_id": "device-row-1"}

    def fake_fetch_one(sql, params=()):
        if "FROM session_devices" in sql:
            return {"id": "device-row-1", "session_id": "session-1", "revoked_at": None}
        if "FROM inventory_sessions" in sql:
            return session
        if "FROM inventory_items" in sql and params[-1] == "client-item-1":
            return item
        return None

    def fake_fetch_all(sql, params=()):
        if "FROM item_photos" in sql:
            return photos
        return []

    monkeypatch.setattr(main, "decode_access_token", fake_decode_access_token)
    monkeypatch.setattr(main, "fetch_one", fake_fetch_one)
    monkeypatch.setattr(main, "fetch_all", fake_fetch_all)

    client = TestClient(main.app)
    response = client.post(
        "/offline-sync/reconcile",
        headers={"Authorization": "Bearer mobile-token"},
        json={
            "session_id": "session-1",
            "source_device_id": "device-1",
            "packages": [
                {"client_item_id": "client-item-1", "client_photo_ids": ["photo-a", "photo-b"]},
                {"client_item_id": "client-item-2", "client_photo_ids": ["photo-x"]},
            ],
        },
    )

    assert response.status_code == 200
    packages = response.json()["packages"]
    assert packages[0]["status"] == "missing_photos"
    assert packages[0]["server_item_id"] == "item-1"
    assert packages[0]["known_client_photo_ids"] == ["photo-a"]
    assert packages[0]["missing_client_photo_ids"] == ["photo-b"]
    assert packages[1]["status"] == "missing"

    session["status"] = "closed"
    closed_response = client.post(
        "/offline-sync/reconcile",
        headers={"Authorization": "Bearer mobile-token"},
        json={"session_id": "session-1", "source_device_id": "device-1", "packages": [{"client_item_id": "client-item-2", "client_photo_ids": []}]},
    )
    assert closed_response.status_code == 200
    assert closed_response.json()["packages"][0]["status"] == "session_closed"


def test_offline_sync_reconcile_marks_deleted_session_discardable(monkeypatch):
    def fake_decode_access_token(_token):
        return {"kind": "mobile_session", "session_id": "session-1", "device_id": "device-row-1"}

    def fake_fetch_one(sql, params=()):
        if "FROM session_devices" in sql:
            return {"id": "device-row-1", "session_id": "session-1", "revoked_at": None}
        return None

    monkeypatch.setattr(main, "decode_access_token", fake_decode_access_token)
    monkeypatch.setattr(main, "fetch_one", fake_fetch_one)

    client = TestClient(main.app)
    response = client.post(
        "/offline-sync/reconcile",
        headers={"Authorization": "Bearer mobile-token"},
        json={"session_id": "session-1", "source_device_id": "device-1", "packages": [{"client_item_id": "client-item-1", "client_photo_ids": ["photo-a"]}]},
    )

    assert response.status_code == 200
    assert response.json()["session_status"] == "missing"
    assert response.json()["packages"][0]["status"] == "discardable"


def test_join_session_reuses_existing_device(monkeypatch):
    session = {"id": "session-1", "tenant_id": "tenant-1", "join_token": "join-token", "status": "open"}
    existing_device = {
        "id": "device-row-1",
        "session_id": "session-1",
        "device_name": "Old name",
        "device_fingerprint": "fingerprint-1",
        "revoked_at": None,
    }
    executed = []

    def fake_fetch_one(sql, params=()):
        if "FROM inventory_sessions" in sql:
            return session
        if "FROM session_devices" in sql:
            return existing_device
        return None

    def fake_execute(sql, params=()):
        executed.append(sql)
        assert "ON CONFLICT (session_id, device_fingerprint)" in sql
        assert params == ("tenant-1", "session-1", "iPhone Scanner", "fingerprint-1")
        return {**existing_device, "device_name": "iPhone Scanner"}

    monkeypatch.setattr(main, "fetch_one", fake_fetch_one)
    monkeypatch.setattr(main, "execute", fake_execute)
    monkeypatch.setattr(main, "audit", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "create_mobile_session_token", lambda session, device: "mobile-token")

    client = TestClient(main.app)
    response = client.post(
        "/sessions/join",
        json={"token": "join-token", "device_name": "iPhone Scanner", "device_fingerprint": "fingerprint-1"},
    )

    assert response.status_code == 200
    assert response.json()["device"]["id"] == "device-row-1"
    assert response.json()["access_token"] == "mobile-token"
    assert executed and "INSERT INTO session_devices" in executed[0]


def test_join_session_blocks_revoked_device(monkeypatch):
    session = {"id": "session-1", "tenant_id": "tenant-1", "join_token": "join-token", "status": "open"}

    def fake_fetch_one(sql, params=()):
        if "FROM inventory_sessions" in sql:
            return session
        if "FROM session_devices" in sql:
            return {
                "id": "device-row-1",
                "session_id": "session-1",
                "device_fingerprint": "fingerprint-1",
                "revoked_at": "2026-06-09T09:00:00Z",
            }
        return None

    def fail_execute(*args, **kwargs):
        raise AssertionError("revoked devices must not be updated or inserted")

    monkeypatch.setattr(main, "fetch_one", fake_fetch_one)
    monkeypatch.setattr(main, "execute", fail_execute)

    client = TestClient(main.app)
    response = client.post(
        "/sessions/join",
        json={"token": "join-token", "device_name": "iPhone Scanner", "device_fingerprint": "fingerprint-1"},
    )

    assert response.status_code == 403
    assert "widerrufen" in response.json()["detail"]
