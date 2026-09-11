"""Credential vault and atomic activation primitives."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import tempfile
from typing import Any, Iterator
import uuid

from .auth import AuthError, auth_freshness, auth_profile, default_alias


class StoreError(RuntimeError):
    pass


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(0o700)


def atomic_write(path: Path, data: bytes, mode: int = 0o600) -> None:
    _ensure_private_dir(path.parent)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
        path.chmod(mode)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def atomic_json(path: Path, value: Any, mode: int = 0o600) -> None:
    atomic_write(path, (json.dumps(value, indent=2, sort_keys=True) + "\n").encode(), mode)


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        raise StoreError(f"cannot read {path}: {exc}") from exc


@dataclass(frozen=True)
class Paths:
    data_home: Path
    codex_home: Path

    @classmethod
    def discover(cls) -> "Paths":
        override = os.environ.get("CDX_SWITCHBOARD_HOME")
        if override:
            data_home = Path(override).expanduser()
        else:
            xdg = Path(os.environ.get("XDG_DATA_HOME", "~/.local/share")).expanduser()
            data_home = xdg / "cdx-switchboard"
        codex_home = Path(os.environ.get("CODEX_HOME", "~/.codex")).expanduser()
        return cls(data_home=data_home, codex_home=codex_home)

    @property
    def accounts(self) -> Path:
        return self.data_home / "accounts"

    @property
    def active(self) -> Path:
        return self.data_home / "active.json"

    @property
    def last_rank(self) -> Path:
        return self.data_home / "last-rank.json"

    @property
    def lock(self) -> Path:
        return self.data_home / "switchboard.lock"

    @property
    def live_auth(self) -> Path:
        return self.codex_home / "auth.json"


@dataclass(frozen=True)
class Account:
    account_id: str
    alias: str
    email: str | None
    identity: str | None
    method: str
    home: Path
    created_at: str
    updated_at: str

    @property
    def auth_path(self) -> Path:
        return self.home / "auth.json"

    @property
    def meta_path(self) -> Path:
        return self.home / "account.json"


class AccountStore:
    def __init__(self, paths: Paths | None = None):
        self.paths = paths or Paths.discover()
        _ensure_private_dir(self.paths.data_home)
        _ensure_private_dir(self.paths.accounts)

    @contextmanager
    def locked(self) -> Iterator[None]:
        _ensure_private_dir(self.paths.data_home)
        with self.paths.lock.open("a+") as handle:
            self.paths.lock.chmod(0o600)
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def _account_from_home(self, home: Path) -> Account | None:
        meta = read_json(home / "account.json")
        if not isinstance(meta, dict) or not (home / "auth.json").is_file():
            return None
        try:
            return Account(
                account_id=str(meta["id"]),
                alias=str(meta["alias"]),
                email=str(meta["email"]) if meta.get("email") else None,
                identity=str(meta["identity"]) if meta.get("identity") else None,
                method=str(meta.get("method") or "unknown"),
                home=home,
                created_at=str(meta.get("created_at") or ""),
                updated_at=str(meta.get("updated_at") or ""),
            )
        except KeyError:
            return None

    def accounts(self) -> list[Account]:
        found = []
        for home in sorted(self.paths.accounts.iterdir()):
            if home.is_dir():
                account = self._account_from_home(home)
                if account:
                    found.append(account)
        return sorted(found, key=lambda account: account.alias.casefold())

    def active_id(self) -> str | None:
        value = read_json(self.paths.active)
        return str(value.get("account_id")) if isinstance(value, dict) and value.get("account_id") else None

    def active_account(self) -> Account | None:
        account_id = self.active_id()
        return next((a for a in self.accounts() if a.account_id == account_id), None)

    def resolve(self, selector: str | None) -> Account:
        accounts = self.accounts()
        if not selector:
            active = self.active_account()
            if active:
                return active
            raise StoreError("no account selected and no active account")

        if selector.isdigit():
            ranked = read_json(self.paths.last_rank)
            ids = ranked.get("account_ids") if isinstance(ranked, dict) else None
            index = int(selector) - 1
            if isinstance(ids, list) and 0 <= index < len(ids):
                match = next((a for a in accounts if a.account_id == ids[index]), None)
                if match:
                    return match

        folded = selector.casefold()
        exact = [
            a for a in accounts
            if folded in {a.account_id.casefold(), a.alias.casefold(), (a.email or "").casefold()}
        ]
        if len(exact) == 1:
            return exact[0]
        partial = [
            a for a in accounts
            if folded in a.alias.casefold() or folded in (a.email or "").casefold()
        ]
        if len(partial) == 1:
            return partial[0]
        if len(partial) > 1:
            names = ", ".join(a.alias for a in partial)
            raise StoreError(f"account selector is ambiguous: {selector!r} ({names})")
        raise StoreError(f"account not found: {selector!r}")

    def add(self, auth_bytes: bytes, alias: str | None = None) -> Account:
        try:
            auth = json.loads(auth_bytes)
            profile = auth_profile(auth)
        except (ValueError, AuthError) as exc:
            raise StoreError(str(exc)) from exc

        existing = self.accounts()
        if profile.identity:
            duplicate = next((a for a in existing if a.identity == profile.identity), None)
            if duplicate:
                raise StoreError(
                    f"this login is already stored as {duplicate.alias!r}; use `cdx relogin {duplicate.alias}`"
                )
        alias = alias or default_alias(profile, {a.alias for a in existing})
        self._validate_alias(alias, existing)

        account_id = str(uuid.uuid4())
        home = self.paths.accounts / account_id
        _ensure_private_dir(home)
        now = _utc_now()
        meta = {
            "id": account_id,
            "alias": alias,
            "email": profile.email,
            "identity": profile.identity,
            "method": profile.method,
            "created_at": now,
            "updated_at": now,
        }
        atomic_write(home / "auth.json", auth_bytes)
        atomic_json(home / "account.json", meta)
        account = self._account_from_home(home)
        if not account:
            raise StoreError("failed to store account")
        return account

    @staticmethod
    def _validate_alias(alias: str, existing: list[Account]) -> None:
        if not alias or alias.casefold() in {"best", "active"}:
            raise StoreError("alias must be non-empty and cannot be 'best' or 'active'")
        if any(ch.isspace() for ch in alias):
            raise StoreError("alias cannot contain whitespace")
        if any(a.alias.casefold() == alias.casefold() for a in existing):
            raise StoreError(f"alias already exists: {alias!r}")

    def replace_auth(self, account: Account, auth_bytes: bytes) -> Account:
        try:
            profile = auth_profile(json.loads(auth_bytes))
        except (ValueError, AuthError) as exc:
            raise StoreError(str(exc)) from exc
        if account.identity and profile.identity != account.identity:
            raise StoreError(
                f"login identity does not match {account.alias!r}; refusing to overwrite that account"
            )
        meta = read_json(account.meta_path)
        if not isinstance(meta, dict):
            raise StoreError(f"metadata missing for {account.alias!r}")
        meta.update({
            "email": profile.email or account.email,
            "identity": profile.identity or account.identity,
            "method": profile.method,
            "updated_at": _utc_now(),
        })
        atomic_write(account.auth_path, auth_bytes)
        atomic_json(account.meta_path, meta)
        updated = self._account_from_home(account.home)
        if not updated:
            raise StoreError("failed to update account")
        return updated

    def live_matches(self, account: Account) -> bool:
        try:
            live = json.loads(self.paths.live_auth.read_bytes())
            if account.identity:
                return auth_profile(live).identity == account.identity
            return live == json.loads(account.auth_path.read_bytes())
        except (OSError, ValueError, AuthError):
            return False

    def sync_live_to_active(self) -> bool:
        account = self.active_account()
        if not account or not self.paths.live_auth.is_file():
            return False
        try:
            live_bytes = self.paths.live_auth.read_bytes()
            live_auth = json.loads(live_bytes)
            live_profile = auth_profile(live_auth)
            stored_auth = json.loads(account.auth_path.read_bytes())
        except (OSError, ValueError, AuthError):
            return False
        if account.identity and live_profile.identity != account.identity:
            return False
        if auth_freshness(live_auth, self.paths.live_auth) <= auth_freshness(stored_auth, account.auth_path):
            return False
        atomic_write(account.auth_path, live_bytes)
        return True

    def copy_to_live(self, account: Account) -> None:
        try:
            auth_bytes = account.auth_path.read_bytes()
            stored_profile = auth_profile(json.loads(auth_bytes))
        except (OSError, ValueError, AuthError) as exc:
            raise StoreError(f"stored credentials for {account.alias!r} are invalid: {exc}") from exc
        if account.identity and stored_profile.identity != account.identity:
            raise StoreError(f"identity mismatch in stored credentials for {account.alias!r}")
        _ensure_private_dir(self.paths.codex_home)
        atomic_write(self.paths.live_auth, auth_bytes)

    def activate(self, account: Account) -> None:
        self.sync_live_to_active()
        self.copy_to_live(account)
        atomic_json(self.paths.active, {
            "account_id": account.account_id,
            "alias": account.alias,
            "activated_at": _utc_now(),
        })

    def import_live(self, alias: str | None = None) -> Account:
        if not self.paths.live_auth.is_file():
            raise StoreError(f"no live Codex credentials at {self.paths.live_auth}")
        return self.add(self.paths.live_auth.read_bytes(), alias)

    def save_rank(self, accounts: list[Account]) -> None:
        atomic_json(self.paths.last_rank, {
            "account_ids": [account.account_id for account in accounts],
            "saved_at": _utc_now(),
        })
