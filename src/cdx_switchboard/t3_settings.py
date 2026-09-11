"""Reversible configuration of T3's default Codex provider."""

from pathlib import Path
import copy
import os
import sqlite3
import subprocess
import sys
import time

from .storage import AccountStore, StoreError, atomic_json, read_json


def connect(store: AccountStore, settings: Path | None = None, launcher: Path | None = None):
    settings = settings or Path.home() / ".t3" / "userdata" / "settings.json"
    launcher = launcher or Path.home() / ".local" / "bin" / "cdx-codex"
    if not launcher.is_file():
        raise StoreError("install cdx-codex before connecting T3")
    config = read_json(settings) or {}
    if not isinstance(config, dict):
        raise StoreError("T3 settings must be a JSON object")
    original = copy.deepcopy(config)
    instances = config.setdefault("providerInstances", {})
    if not isinstance(instances, dict):
        raise StoreError("T3 providerInstances must be a JSON object")
    entry = instances.setdefault("codex", {"driver": "codex", "enabled": True, "config": {}})
    if entry.get("driver", "codex") != "codex":
        raise StoreError("the default T3 provider is not a Codex provider")
    provider = entry.setdefault("config", {})
    if provider.get("shadowHomePath") or provider.get("homePath"):
        raise StoreError("the default T3 provider has a custom account home; preserve it and configure a separate managed provider")
    backup = store.paths.data_home / "t3-settings-before-managed.json"
    if not backup.exists():
        atomic_json(backup, {"path": str(settings), "existed": settings.exists(), "settings": original})
    provider["binaryPath"] = str(launcher)
    atomic_json(settings, config)
    return settings


def busy(database: Path | None = None):
    database = database or Path.home() / ".t3/userdata/state.sqlite"
    if not database.exists():
        return False
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=3) as db:
        return bool(db.execute(
            "SELECT count(*) FROM projection_thread_sessions WHERE provider_name = 'codex' "
            "AND status NOT IN ('ready', 'stopped', 'error')"
        ).fetchone()[0])


def connect_or_schedule(store: AccountStore):
    status = store.paths.data_home / "t3-integration.json"
    if not busy():
        path = connect(store)
        atomic_json(status, {"status": "connected", "settings": str(path)})
        return "connected"
    existing = read_json(status) or {}
    if existing.get("status") == "waiting" and existing.get("pid"):
        try:
            os.kill(int(existing["pid"]), 0)
            return "waiting for current T3 turns to finish"
        except (ProcessLookupError, ValueError):
            pass
    env = os.environ.copy()
    env["PYTHONPATH"] = str(Path(__file__).resolve().parent.parent)
    process = subprocess.Popen([sys.executable, "-m", "cdx_switchboard.t3_settings"],
                               env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, start_new_session=True)
    atomic_json(status, {"status": "waiting", "pid": process.pid})
    return "will connect automatically when current T3 turns finish"


if __name__ == "__main__":
    store = AccountStore()
    status = store.paths.data_home / "t3-integration.json"
    try:
        deadline = time.monotonic() + 86400
        while time.monotonic() < deadline:
            time.sleep(5)
            if busy():
                continue
            time.sleep(2)
            if not busy():
                path = connect(store)
                atomic_json(status, {"status": "connected", "settings": str(path)})
                break
        else:
            atomic_json(status, {"status": "pending", "message": "Run cdx setup --t3 when T3 is idle."})
    except (OSError, ValueError, StoreError, sqlite3.Error):
        atomic_json(status, {"status": "failed", "message": "Run cdx setup --t3 to retry."})
