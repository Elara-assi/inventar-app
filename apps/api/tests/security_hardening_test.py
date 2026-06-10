from pathlib import Path

from fastapi.testclient import TestClient

from app import main
from app.security import verify_password


def test_audio_upload_ignores_dangerous_filename(monkeypatch, tmp_path):
    stored = {}

    def fake_decode_access_token(_token):
        return {"kind": "user", "sub": "user-1", "roles": ["admin"]}

    def fake_fetch_one(sql, params=()):
        if "FROM inventory_items i" in sql and "JOIN inventory_sessions" in sql:
            return {"id": params[0], "session_id": "session-1", "session_status": "open"}
        return None

    def fake_execute(sql, params=()):
        if "INSERT INTO item_audio_notes" in sql:
            stored["audio_path"] = params[1]
            return {
                "id": "audio-1",
                "item_id": params[0],
                "audio_path": params[1],
                "transcript": params[2],
                "transcript_status": "completed",
            }
        return {"id": "audit-1"}

    monkeypatch.setattr(main, "decode_access_token", fake_decode_access_token)
    monkeypatch.setattr(main, "fetch_one", fake_fetch_one)
    monkeypatch.setattr(main, "execute", fake_execute)
    monkeypatch.setattr(main, "audit", lambda *args, **kwargs: None)
    monkeypatch.setattr(main.settings, "upload_root", str(tmp_path))

    client = TestClient(main.app)
    response = client.post(
        "/items/item-1/audio",
        headers={"Authorization": "Bearer user-token"},
        files={"file": ("../../escape.webm", b"voice-bytes", "audio/webm")},
    )

    assert response.status_code == 200
    audio_path = Path(response.json()["audio_path"]).resolve()
    upload_root = tmp_path.resolve()
    assert upload_root in audio_path.parents
    assert audio_path.parent == upload_root / "audio"
    assert ".." not in audio_path.name
    assert "escape" not in audio_path.name
    assert audio_path.read_bytes() == b"voice-bytes"


def test_created_user_gets_random_hashed_password_not_demo(monkeypatch):
    created = {}

    def fake_decode_access_token(_token):
        return {"kind": "user", "sub": "admin-1", "roles": ["admin"]}

    def fake_fetch_one(sql, params=()):
        if "FROM users WHERE lower(email)" in sql:
            return None
        if "FROM tenants" in sql:
            return {"id": "tenant-1"}
        if "FROM roles" in sql:
            return {"id": "role-1"}
        return None

    def fake_execute(sql, params=()):
        if "INSERT INTO users" in sql:
            created["password_hash"] = params[3]
            return {
                "id": "user-1",
                "tenant_id": params[0],
                "email": params[1],
                "display_name": params[2],
                "password_hash": params[3],
                "password_reset_required": True,
            }
        if "INSERT INTO user_roles" in sql:
            return {"user_id": "user-1"}
        return {"id": "audit-1"}

    monkeypatch.setattr(main, "decode_access_token", fake_decode_access_token)
    monkeypatch.setattr(main, "fetch_one", fake_fetch_one)
    monkeypatch.setattr(main, "execute", fake_execute)
    monkeypatch.setattr(main, "audit", lambda *args, **kwargs: None)

    client = TestClient(main.app)
    response = client.post(
        "/users",
        headers={"Authorization": "Bearer user-token"},
        json={"display_name": "Pilot User", "email": "pilot@example.local", "role_slug": "erfasser"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["password_reset_required"] is True
    assert payload["initial_password"]
    assert payload["initial_password"] != "demo"
    assert created["password_hash"] != "demo"
    assert verify_password(payload["initial_password"], created["password_hash"])
    assert not verify_password("demo", created["password_hash"])


def test_default_auth_secret_is_not_used_for_signing():
    assert main.settings.auth_secret != "change-me-in-env"
