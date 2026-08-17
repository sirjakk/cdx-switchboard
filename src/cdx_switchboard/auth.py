"""Small, deliberately non-validating helpers for Codex auth metadata.

JWT claims are decoded only to identify a locally stored login. Authentication
and token validation remain the Codex CLI's responsibility.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from datetime import datetime
import json
from pathlib import Path
from typing import Any


class AuthError(ValueError):
    pass


def jwt_payload(token: str | None) -> dict[str, Any]:
    if not token or token.count(".") < 2:
        return {}
    try:
        payload = token.split(".", 2)[1]
        payload += "=" * (-len(payload) % 4)
        decoded = base64.urlsafe_b64decode(payload.encode("ascii"))
        value = json.loads(decoded)
        return value if isinstance(value, dict) else {}
    except (ValueError, UnicodeError):
        return {}


@dataclass(frozen=True)
class AuthProfile:
    subject: str | None
    email: str | None
    method: str

    @property
    def identity(self) -> str | None:
        if self.subject:
            return f"sub:{self.subject}"
        if self.email:
            return f"email:{self.email.casefold()}"
        return None


def auth_profile(auth: dict[str, Any]) -> AuthProfile:
    if not isinstance(auth, dict):
        raise AuthError("auth.json is not a JSON object")

    tokens = auth.get("tokens")
    if isinstance(tokens, dict):
        access = jwt_payload(tokens.get("access_token"))
        identity = jwt_payload(tokens.get("id_token"))
        profile_claim = identity.get("https://api.openai.com/profile")
        if not isinstance(profile_claim, dict):
            profile_claim = {}
        subject = access.get("sub") or identity.get("sub")
        email = identity.get("email") or profile_claim.get("email")
        if any(tokens.get(key) for key in ("access_token", "refresh_token", "id_token")):
            return AuthProfile(
                subject=str(subject) if subject else None,
                email=str(email).strip() if email else None,
                method="chatgpt",
            )

    if auth.get("OPENAI_API_KEY"):
        return AuthProfile(subject=None, email=None, method="api_key")

    raise AuthError("auth.json does not contain recognizable Codex credentials")


def auth_freshness(auth: dict[str, Any], path: Path) -> tuple[float, float]:
    """Best-effort monotonic comparison key for two copies of one login."""
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = 0.0
    refreshed = auth.get("last_refresh") if isinstance(auth, dict) else None
    if refreshed:
        try:
            return datetime.fromisoformat(str(refreshed).replace("Z", "+00:00")).timestamp(), mtime
        except ValueError:
            pass
    tokens = auth.get("tokens") if isinstance(auth, dict) else None
    if isinstance(tokens, dict):
        for key in ("access_token", "id_token"):
            issued = jwt_payload(tokens.get(key)).get("iat")
            if isinstance(issued, (int, float)):
                return float(issued), mtime
    return mtime, mtime


def default_alias(profile: AuthProfile, existing: set[str]) -> str:
    if profile.email:
        base = profile.email.split("@", 1)[0]
    elif profile.method == "api_key":
        base = "api"
    else:
        base = "account"
    base = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in base).strip("-")
    base = base or "account"
    candidate = base
    suffix = 2
    folded = {name.casefold() for name in existing}
    while candidate.casefold() in folded:
        candidate = f"{base}-{suffix}"
        suffix += 1
    return candidate
