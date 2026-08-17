"""All interaction with the installed Codex CLI lives here."""

from __future__ import annotations

import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import time
from typing import Any


FILE_STORE_OVERRIDE = 'cli_auth_credentials_store="file"'


class CodexError(RuntimeError):
    pass


class CodexClient:
    def __init__(self, binary: str | None = None):
        self.binary = binary or os.environ.get("CDX_CODEX_BIN") or shutil.which("codex") or "codex"

    def ensure_available(self) -> None:
        if not shutil.which(self.binary) and not Path(self.binary).is_file():
            raise CodexError(f"Codex CLI not found: {self.binary}")

    def login(self, staging_home: Path, *, device_auth: bool = False) -> bytes:
        self.ensure_available()
        staging_home.mkdir(parents=True, exist_ok=True)
        staging_home.chmod(0o700)
        env = os.environ.copy()
        env["CODEX_HOME"] = str(staging_home)
        command = [self.binary, "login"]
        if device_auth:
            command.append("--device-auth")
        command.extend(["-c", FILE_STORE_OVERRIDE])
        try:
            result = subprocess.run(command, env=env, check=False)
        except KeyboardInterrupt as exc:
            raise CodexError("login cancelled") from exc
        except OSError as exc:
            raise CodexError(f"could not start Codex login: {exc}") from exc
        if result.returncode != 0:
            raise CodexError(f"codex login exited with status {result.returncode}")
        auth_path = staging_home / "auth.json"
        if not auth_path.is_file():
            raise CodexError("codex login succeeded but did not create auth.json")
        return auth_path.read_bytes()

    def rate_limits(self, account_home: Path, timeout: float = 12.0) -> dict[str, Any]:
        """Read usage through Codex app-server, letting Codex own token refresh."""
        self.ensure_available()
        env = os.environ.copy()
        env["CODEX_HOME"] = str(account_home)
        process = subprocess.Popen(
            [self.binary, "app-server", "-c", FILE_STORE_OVERRIDE],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            env=env,
        )
        try:
            assert process.stdin is not None
            self._send(process.stdin, {
                "id": 1,
                "method": "initialize",
                "params": {"clientInfo": {"name": "cdx-switchboard", "version": "0.1.0"}},
            })
            initialized = self._read_response(process, 1, timeout)
            if initialized.get("error"):
                raise CodexError("Codex app-server initialization failed")
            self._send(process.stdin, {"method": "initialized", "params": None})
            self._send(process.stdin, {"id": 2, "method": "account/rateLimits/read", "params": None})
            response = self._read_response(process, 2, timeout)
            if response.get("error"):
                error = response["error"]
                message = error.get("message") if isinstance(error, dict) else str(error)
                raise CodexError(message or "Codex app-server returned an error")
            result = response.get("result")
            if not isinstance(result, dict):
                raise CodexError("Codex app-server returned no rate-limit data")
            return result
        finally:
            if process.stdin:
                process.stdin.close()
            process.terminate()
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=1)
            if process.stdout:
                process.stdout.close()

    @staticmethod
    def _send(stream: Any, message: dict[str, Any]) -> None:
        stream.write(json.dumps(message, separators=(",", ":")) + "\n")
        stream.flush()

    @staticmethod
    def _read_response(process: subprocess.Popen[str], request_id: int, timeout: float) -> dict[str, Any]:
        assert process.stdout is not None
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + timeout
        try:
            while time.monotonic() < deadline:
                remaining = max(0.0, deadline - time.monotonic())
                if not selector.select(remaining):
                    break
                line = process.stdout.readline()
                if not line:
                    break
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if isinstance(message, dict) and message.get("id") == request_id:
                    return message
            if process.poll() is not None:
                raise CodexError(f"Codex app-server exited with status {process.returncode}")
            raise CodexError("timed out waiting for Codex app-server")
        finally:
            selector.close()

    def launch(self, codex_home: Path, args: list[str]) -> None:
        self.ensure_available()
        env = os.environ.copy()
        env["CODEX_HOME"] = str(codex_home)
        command = [self.binary, "-c", FILE_STORE_OVERRIDE, *args]
        try:
            os.execvpe(self.binary, command, env)
        except OSError as exc:
            raise CodexError(f"could not launch Codex: {exc}") from exc


def running_codex_processes() -> list[str]:
    """Best-effort guard against switching beneath a live Codex session."""
    if not Path("/proc").is_dir():
        return []
    current = {os.getpid(), os.getppid()}
    matches: list[str] = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit() or int(entry.name) in current:
            continue
        try:
            parts = (entry / "cmdline").read_bytes().split(b"\0")
            args = [part.decode(errors="replace") for part in parts if part]
        except (OSError, ValueError):
            continue
        if not args:
            continue
        command = " ".join(args)
        executable = Path(args[0]).name
        is_codex = executable in {"codex", "codex.js", "codex-x86_64-unknown-linux-musl"}
        if is_codex and "app-server" not in args and " login" not in command:
            matches.append(command)
    return matches
