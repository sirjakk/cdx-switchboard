from __future__ import annotations

import base64
import json
from pathlib import Path


def _token(payload: dict) -> str:
    raw = json.dumps(payload, separators=(",", ":")).encode()
    encoded = base64.urlsafe_b64encode(raw).decode().rstrip("=")
    return f"header.{encoded}.signature"


def auth_bytes(subject: str, email: str, issued_at: int = 100) -> bytes:
    return json.dumps({
        "tokens": {
            "access_token": _token({"sub": subject, "iat": issued_at, "exp": issued_at + 3600}),
            "id_token": _token({"sub": subject, "email": email, "iat": issued_at}),
            "refresh_token": f"refresh-{subject}-{issued_at}",
        }
    }).encode()
