from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, Request

from .db import fetch_one
from .settings import settings


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    iterations = 260_000
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"pbkdf2_sha256${iterations}${_b64url_encode(salt)}${_b64url_encode(digest)}"


def verify_password(password: str, stored_hash: str | None) -> bool:
    if not stored_hash:
        return False
    # Legacy seed users used the literal value "demo". Keep this only for
    # backwards-compatible rollout; newly created passwords should use PBKDF2.
    if stored_hash == "demo":
        return password == "demo"
    try:
        scheme, iterations_text, salt_text, digest_text = stored_hash.split("$", 3)
        if scheme != "pbkdf2_sha256":
            return False
        iterations = int(iterations_text)
        salt = _b64url_decode(salt_text)
        expected = _b64url_decode(digest_text)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def create_access_token(user: dict[str, Any]) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "iss": "inventar-api",
        "sub": str(user["id"]),
        "email": user.get("email"),
        "roles": user.get("roles") or [],
        "tenant_id": str(user.get("tenant_id") or ""),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=settings.auth_token_minutes)).timestamp()),
    }
    header = {"alg": "HS256", "typ": "JWT"}
    signing_input = f"{_b64url_encode(json.dumps(header, separators=(',', ':')).encode())}.{_b64url_encode(json.dumps(payload, separators=(',', ':')).encode())}"
    signature = hmac.new(settings.auth_secret.encode("utf-8"), signing_input.encode("ascii"), hashlib.sha256).digest()
    return f"{signing_input}.{_b64url_encode(signature)}"


def decode_access_token(token: str) -> dict[str, Any]:
    try:
        header_text, payload_text, signature_text = token.split(".", 2)
        signing_input = f"{header_text}.{payload_text}"
        expected = hmac.new(settings.auth_secret.encode("utf-8"), signing_input.encode("ascii"), hashlib.sha256).digest()
        actual = _b64url_decode(signature_text)
        if not hmac.compare_digest(actual, expected):
            raise ValueError("bad signature")
        payload = json.loads(_b64url_decode(payload_text))
        if int(payload.get("exp", 0)) < int(datetime.now(timezone.utc).timestamp()):
            raise ValueError("expired")
        return payload
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Token ungueltig oder abgelaufen") from exc


def bearer_token_from_request(request: Request) -> str | None:
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return None


def current_user_from_request(request: Request) -> dict[str, Any] | None:
    token = bearer_token_from_request(request)
    if not token:
        return None
    payload = decode_access_token(token)
    return fetch_one(
        """
        SELECT u.*, array_remove(array_agg(r.slug), null) AS roles
        FROM users u
        LEFT JOIN user_roles ur ON ur.user_id = u.id
        LEFT JOIN roles r ON r.id = ur.role_id
        WHERE u.id = %s AND u.active = true
        GROUP BY u.id
        """,
        (payload["sub"],),
    )


def require_user(request: Request) -> dict[str, Any]:
    user = current_user_from_request(request)
    if not user:
        raise HTTPException(status_code=401, detail="Anmeldung erforderlich")
    return user


def request_id() -> str:
    return os.urandom(8).hex()
