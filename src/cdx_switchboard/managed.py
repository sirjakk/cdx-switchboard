"""Account-pinned Codex runtimes with serialized, Codex-owned token refresh."""

from __future__ import annotations

from contextlib import contextmanager
import fcntl
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

from .auth import auth_profile
from .codex import AuthenticationRequired, CodexClient, CodexError, FILE_STORE_OVERRIDE, client_environment
from .storage import Account, AccountStore, StoreError, atomic_json, read_json


@contextmanager
def account_lock(account: Account):
    with (account.home / "refresh.lock").open("a+") as lock:
        os.fchmod(lock.fileno(), 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield lock
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


class Authority:
    def __init__(self, account: Account, client: CodexClient):
        self.account = account
        self.client = client

    def _read(self):
        auth = read_json(self.account.auth_path)
        if not isinstance(auth, dict) or auth_profile(auth).identity != self.account.identity:
            raise StoreError("saved account identity does not match")
        return auth

    def snapshot(self):
        with account_lock(self.account):
            return self._read()

    def refresh(self, requested_token: str):
        # A separate process owns each worker's callback server. This file lock
        # coordinates all of them, including ranking and relogin.
        with account_lock(self.account) as lock:
            auth = self._read()
            if auth.get("tokens", {}).get("refresh_token") == requested_token:
                # The helper inherits the lock too. If this worker is killed,
                # another worker still waits until that helper has finished.
                self.client.refresh(self.account.home, lock_fd=lock.fileno())
                auth = self._read()
            tokens = auth.get("tokens", {})
            if not tokens.get("access_token") or not tokens.get("refresh_token"):
                raise AuthenticationRequired("saved login needs reauthentication")
            return {k: tokens[k] for k in ("access_token", "id_token", "refresh_token") if tokens.get(k)}

    def rate_limits(self):
        with account_lock(self.account) as lock:
            self._read()
            return self.client.rate_limits(self.account.home, lock_fd=lock.fileno())


class RefreshServer:
    """Private loopback callback used only by this runtime's Codex processes.

    Codex itself contacts OpenAI and persists rotated tokens in the authority
    home. Workers receive a copy, so delayed writes cannot roll the vault back.
    """

    def __init__(self, authority: Authority, auth: dict):
        self.authority = authority
        self.nonce = secrets.token_urlsafe(32)
        self.issued = set()
        self.guard = threading.Lock()
        token = auth.get("tokens", {}).get("refresh_token")
        if token:
            self.issued.add(hashlib.sha256(token.encode()).digest())
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def respond(self, status, body):
                raw = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                try:
                    self.wfile.write(raw)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def do_POST(self):
                self.connection.settimeout(35)
                if self.path not in (f"/{owner.nonce}/refresh", f"/{owner.nonce}/revoke"):
                    self.respond(404, {"error": "not found"})
                    return
                try:
                    size = int(self.headers.get("Content-Length", "0"))
                    if not 0 < size <= 65536:
                        raise ValueError("invalid request size")
                    data = json.loads(self.rfile.read(size))
                    presented = data.get("refresh_token") or data.get("token")
                    if not isinstance(presented, str):
                        raise ValueError("token missing")
                    digest = hashlib.sha256(presented.encode()).digest()
                    with owner.guard:
                        recognized = digest in owner.issued
                    if not recognized:
                        self.respond(401, {"error": {"code": "refresh_token_invalidated",
                                     "message": "Use cdx relogin to update this saved account."}})
                        return
                    if self.path.endswith("/revoke"):
                        # A worker logout ends that worker's login. The saved
                        # account belongs to cdx and remains available to others.
                        self.respond(200, {})
                        return
                    result = owner.authority.refresh(presented)
                    with owner.guard:
                        owner.issued.add(hashlib.sha256(result["refresh_token"].encode()).digest())
                    self.respond(200, result)
                except (ValueError, TypeError, AttributeError):
                    self.respond(400, {"error": "invalid request"})
                except AuthenticationRequired:
                    self.respond(401, {"error": {"code": "refresh_token_invalidated",
                                 "message": "Saved login was revoked; run cdx relogin for this account."}})
                except (CodexError, StoreError, OSError):
                    self.respond(503, {"error": "Credential refresh temporarily unavailable."})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = False
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    @property
    def environment(self):
        base = f"http://127.0.0.1:{self.server.server_port}/{self.nonce}"
        return {"CODEX_REFRESH_TOKEN_URL_OVERRIDE": base + "/refresh",
                "CODEX_REVOKE_TOKEN_URL_OVERRIDE": base + "/revoke"}


@contextmanager
def runtime_home(store: AccountStore, account: Account, client: CodexClient):
    root = store.paths.data_home / "runtimes"
    root.mkdir(mode=0o700, exist_ok=True)
    root.chmod(0o700)
    authority = Authority(account, client)
    auth = authority.snapshot()
    with tempfile.TemporaryDirectory(prefix="session-", dir=root) as temporary:
        home = Path(temporary)
        # Share normal Codex configuration and conversation history. Auth,
        # sockets, temporary files, and refresh writes belong to this runtime.
        shared = store.paths.codex_home
        shared.mkdir(mode=0o700, parents=True, exist_ok=True)
        for source in shared.iterdir():
            if source.name.startswith(("auth", ".auth", ".")) or source.name in {
                "tmp", "log", "logs", "memories", "models_cache.json", "app-server",
            } or source.is_socket() or source.name.endswith((".sock", ".lock")):
                continue
            if source.is_file() or source.is_dir():
                (home / source.name).symlink_to(source.resolve())
        for name in ("sessions", "archived_sessions", "skills", "rules"):
            if not (home / name).exists():
                (shared / name).mkdir(mode=0o700, exist_ok=True)
                (home / name).symlink_to(shared / name)
        atomic_json(home / "auth.json", auth)
        atomic_json(home / "cdx-runtime.json", {"account": account.alias, "pid": os.getpid()})
        with RefreshServer(authority, auth) as callback:
            yield home, callback.environment


def managed_client(store: AccountStore):
    config = read_json(store.paths.managed) or {}
    return CodexClient(os.environ.get("CDX_CODEX_BIN") or config.get("codex_binary"))


def setup(store: AccountStore, client: CodexClient):
    client.ensure_available()
    with store.locked():
        if not store.paths.managed.exists():
            store.sync_live_to_active()
            if store.paths.live_auth.is_file():
                profile = auth_profile(json.loads(store.paths.live_auth.read_bytes()))
                if not any(a.identity == profile.identity for a in store.accounts()):
                    account = store.import_live()
                    store._mark_active(account)
        binary = str(Path(shutil.which(client.binary) or client.binary).absolute())
        if Path(binary).name == "cdx-codex":
            raise StoreError("the authority binary must be the original Codex executable")
        atomic_json(store.paths.managed, {"version": 1, "codex_binary": binary,
                                         "shared_codex_home": str(store.paths.codex_home.absolute())})


def run(store: AccountStore, client: CodexClient, args: list[str]) -> int:
    account = store.resolve(os.environ.get("CDX_ACCOUNT"))
    client.ensure_available()
    with runtime_home(store, account, client) as (home, callbacks):
        env = client_environment()
        for kind in ("REFRESH", "REVOKE"):
            original = env.get(f"CODEX_{kind}_TOKEN_URL_OVERRIDE")
            if original:
                env[f"CDX_ORIGINAL_{kind}_URL"] = original
        env.update(callbacks)
        env["CODEX_HOME"] = str(home)
        env["CDX_MANAGED_RUNTIME"] = "1"
        # Account routing is explicit. Ambient API credentials must not silently
        # replace the saved ChatGPT login in a managed worker.
        for name in ("OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"):
            env.pop(name, None)
        command = [client.binary, *args, "-c", FILE_STORE_OVERRIDE]
        daemon = None
        # Interactive Codex normally starts a persistent daemon. Supervise a
        # private one so its callback lives as long as the interactive client.
        interactive = not args or args[0] in {"resume", "fork"} or (
            args[0].startswith("-") and args[0] not in {"--help", "-h", "--version", "-V"}
        )
        try:
            if interactive:
                socket = home / "worker.sock"
                daemon = subprocess.Popen(
                    [client.binary, "app-server", "--listen", f"unix://{socket}", "-c", FILE_STORE_OVERRIDE],
                    env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
                deadline = time.monotonic() + 15
                while not socket.exists():
                    if daemon.poll() is not None or time.monotonic() > deadline:
                        raise CodexError("could not start the account's local Codex server")
                    time.sleep(0.05)
                command = [client.binary, "--remote", f"unix://{socket}", *args, "-c", FILE_STORE_OVERRIDE]
            child = subprocess.Popen(command, env=env)
            previous = {}
            for sig in (signal.SIGTERM, signal.SIGHUP):
                previous[sig] = signal.signal(sig, lambda number, frame: child.send_signal(number))
            try:
                return child.wait()
            except KeyboardInterrupt:
                child.send_signal(signal.SIGINT)
                return child.wait()
            finally:
                for sig, handler in previous.items():
                    signal.signal(sig, handler)
        finally:
            if daemon is not None:
                daemon.terminate()
                try:
                    daemon.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    daemon.kill()
                    daemon.wait()


def main():
    store = AccountStore()
    client = managed_client(store)
    args = sys.argv[1:]
    try:
        if args in (["--version"], ["-V"], ["--help"], ["-h"]):
            raise SystemExit(subprocess.call([client.binary, *args]))
        if args and args[0] == "login" and args[1:] != ["status"]:
            from .cli import cmd_relogin
            cmd_relogin(store, client, os.environ.get("CDX_ACCOUNT"), "--device-auth" in args)
            return
        if args == ["logout"]:
            print("Saved accounts are retained. Use cdx use <account> to change accounts.")
            return
        if not store.paths.managed.is_file():
            raise StoreError("run `cdx setup` before using managed Codex")
        raise SystemExit(run(store, client, args))
    except (StoreError, CodexError, OSError) as exc:
        print(f"cdx: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
