"""Detached systemd handoff orchestration for ``cdx switch``."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import fcntl
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
from typing import Callable, Iterator, Mapping, TextIO


T3_SERVICE = "t3code.service"
TRANSIENT_UNIT = "cdx-switchboard-switch.service"
RUNTIME_ENV = "CDX_SWITCH_RUNTIME_DIR"


class HandoffError(RuntimeError):
    """A detached account handoff could not be scheduled or completed."""


@dataclass(frozen=True)
class AccountSelection:
    account_id: str
    alias: str
    changed: bool


def _ensure_private_directory(path: Path) -> Path:
    try:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        stat = path.lstat()
    except OSError as exc:
        raise HandoffError(f"cannot create private runtime directory: {exc}") from exc
    if path.is_symlink() or not path.is_dir() or stat.st_uid != os.getuid():
        raise HandoffError("switch runtime path is not a private user-owned directory")
    path.chmod(0o700)
    return path


def runtime_directory(
    environ: Mapping[str, str] | None = None,
    *,
    temp_root: Path | None = None,
) -> Path:
    env = os.environ if environ is None else environ
    explicit = env.get(RUNTIME_ENV)
    if explicit:
        explicit_path = Path(explicit)
        if not explicit_path.is_absolute():
            raise HandoffError("switch runtime path must be absolute")
        return _ensure_private_directory(explicit_path)

    xdg_value = env.get("XDG_RUNTIME_DIR")
    if xdg_value:
        xdg = Path(xdg_value)
        try:
            stat = xdg.stat()
        except OSError:
            stat = None
        if xdg.is_absolute() and stat and xdg.is_dir() and stat.st_uid == os.getuid():
            return _ensure_private_directory(xdg / "cdx-switchboard")

    fallback_root = temp_root or Path(tempfile.gettempdir())
    return _ensure_private_directory(fallback_root / f"cdx-switchboard-{os.getuid()}")


def _open_log(directory: Path, *, truncate: bool) -> TextIO:
    flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW
    flags |= os.O_TRUNC if truncate else os.O_APPEND
    try:
        fd = os.open(directory / "last-switch.log", flags, 0o600)
        os.fchmod(fd, 0o600)
        return os.fdopen(fd, "w", buffering=1)
    except OSError as exc:
        raise HandoffError(f"cannot open the temporary switch log: {exc}") from exc


def prepare_log(directory: Path) -> Path:
    """Privately truncate the one retained handoff log."""
    with _open_log(directory, truncate=True):
        pass
    return directory / "last-switch.log"


def _log(handle: TextIO, event: str) -> None:
    timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    handle.write(f"{timestamp} {event}\n")
    handle.flush()


@contextmanager
def operation_lock(directory: Path) -> Iterator[None]:
    flags = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW
    try:
        fd = os.open(directory / "switch.lock", flags, 0o600)
        os.fchmod(fd, 0o600)
    except OSError as exc:
        raise HandoffError(f"cannot open the switch-operation lock: {exc}") from exc
    with os.fdopen(fd, "r+") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise HandoffError("another account switch operation is already running") from exc
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def validate_user_systemd(
    *,
    runner: Callable[..., subprocess.CompletedProcess[str]] | None = None,
    which: Callable[[str], str | None] | None = None,
) -> tuple[str, str]:
    run = runner or subprocess.run
    find = which or shutil.which
    systemd_run = find("systemd-run")
    systemctl = find("systemctl")
    if not systemd_run or not systemctl:
        raise HandoffError("cdx switch requires systemd-run and systemctl")
    try:
        result = run(
            [systemctl, "--user", "show", "--property=Version", "--value"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            check=False,
        )
    except OSError as exc:
        raise HandoffError(f"cannot contact the systemd user manager: {exc}") from exc
    if result.returncode != 0:
        raise HandoffError("systemd user services are unavailable")
    return systemd_run, systemctl


def helper_command(
    systemd_run: str,
    launcher: Path,
    directory: Path,
    environ: Mapping[str, str] | None = None,
) -> list[str]:
    env = os.environ if environ is None else environ
    command = [
        systemd_run,
        "--user",
        f"--unit={TRANSIENT_UNIT}",
        "--collect",
        "--property=Type=exec",
        "--property=StandardOutput=null",
        "--property=StandardError=null",
        f"--setenv={RUNTIME_ENV}={directory}",
    ]
    for name in ("CDX_SWITCHBOARD_HOME", "CODEX_HOME", "CDX_CODEX_BIN"):
        value = env.get(name)
        if value:
            command.append(f"--setenv={name}={value}")
    command.extend([str(launcher), "_switch-helper"])
    return command


def schedule_handoff(
    launcher: Path,
    *,
    environ: Mapping[str, str] | None = None,
    runner: Callable[..., subprocess.CompletedProcess[str]] | None = None,
    which: Callable[[str], str | None] | None = None,
) -> Path:
    run = runner or subprocess.run
    systemd_run, _ = validate_user_systemd(runner=run, which=which)
    directory = runtime_directory(environ)
    log_path = directory / "last-switch.log"
    command = helper_command(systemd_run, launcher, directory, environ)
    try:
        result = run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
    except OSError as exc:
        raise HandoffError(f"could not schedule the detached switch helper: {exc}") from exc
    if result.returncode != 0:
        raise HandoffError("systemd refused to schedule the detached switch helper")
    return log_path


def _systemctl(
    systemctl: str,
    action: str,
    *,
    runner: Callable[..., subprocess.CompletedProcess[str]],
) -> None:
    try:
        result = runner(
            [systemctl, "--user", action, T3_SERVICE],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            check=False,
        )
    except OSError as exc:
        raise HandoffError(f"could not {action} {T3_SERVICE}: {exc}") from exc
    if result.returncode != 0:
        raise HandoffError(f"systemctl could not {action} {T3_SERVICE}")


def _active_state(
    systemctl: str,
    *,
    runner: Callable[..., subprocess.CompletedProcess[str]],
) -> str:
    try:
        result = runner(
            [systemctl, "--user", "show", T3_SERVICE, "--property=ActiveState", "--value"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            check=False,
        )
    except OSError as exc:
        raise HandoffError(f"could not inspect {T3_SERVICE}: {exc}") from exc
    if result.returncode != 0:
        raise HandoffError(f"could not inspect {T3_SERVICE}")
    return result.stdout.strip()


def _wait_for_t3(
    systemctl: str,
    *,
    active: bool,
    runner: Callable[..., subprocess.CompletedProcess[str]],
    sleeper: Callable[[float], None],
    timeout: float,
) -> None:
    deadline = time.monotonic() + timeout
    while True:
        state = _active_state(systemctl, runner=runner)
        if (active and state == "active") or (not active and state in {"inactive", "failed"}):
            return
        if time.monotonic() >= deadline:
            goal = "become active" if active else "stop"
            raise HandoffError(f"timed out waiting for {T3_SERVICE} to {goal}")
        sleeper(0.25)


def perform_handoff(
    switch_best: Callable[[], AccountSelection],
    verify_current: Callable[[], str],
    *,
    directory: Path | None = None,
    runner: Callable[..., subprocess.CompletedProcess[str]] | None = None,
    which: Callable[[str], str | None] | None = None,
    sleeper: Callable[[float], None] | None = None,
    timeout: float = 60.0,
) -> None:
    run = runner or subprocess.run
    sleep = sleeper or time.sleep
    find = which or shutil.which
    runtime = directory or runtime_directory()
    systemctl = find("systemctl")
    if not systemctl:
        raise HandoffError("cdx switch requires systemctl")

    with operation_lock(runtime):
        with _open_log(runtime, truncate=True) as log:
            _log(log, "helper started")
            stop_attempted = False
            switch_recorded = False
            verification_recorded = False
            failure: Exception | None = None
            restart_failure: Exception | None = None
            try:
                stop_attempted = True
                _systemctl(systemctl, "stop", runner=run)
                _wait_for_t3(
                    systemctl,
                    active=False,
                    runner=run,
                    sleeper=sleep,
                    timeout=timeout,
                )
                _log(log, "T3 stopped")
                try:
                    selection = switch_best()
                except Exception:
                    _log(log, "account switch failure")
                    switch_recorded = True
                    _log(log, "verification result: not performed because switching failed")
                    verification_recorded = True
                    raise
                change = "account changed" if selection.changed else "no account change necessary"
                _log(log, f"selected account: {selection.alias} ({change})")
                switch_recorded = True
                try:
                    current_id = verify_current()
                    if current_id != selection.account_id:
                        raise HandoffError("active account does not match the selected account")
                except Exception:
                    _log(log, "verification result: failure")
                    verification_recorded = True
                    raise
                _log(log, f"verification result: success ({selection.alias})")
                verification_recorded = True
            except Exception as exc:
                failure = exc
                if not switch_recorded:
                    _log(log, "account switch failure: not attempted because T3 did not stop")
                if not verification_recorded:
                    _log(log, "verification result: not performed")
            finally:
                if stop_attempted:
                    try:
                        _systemctl(systemctl, "start", runner=run)
                        _wait_for_t3(
                            systemctl,
                            active=True,
                            runner=run,
                            sleeper=sleep,
                            timeout=timeout,
                        )
                        _log(log, "T3 restarted")
                    except Exception as exc:
                        restart_failure = exc
                        _log(log, "T3 restart failed")

            if failure is None and restart_failure is None:
                _log(log, "final success")
                return
            _log(log, "final failure")
            if restart_failure is not None:
                raise HandoffError("account handoff failed to restore T3") from restart_failure
            assert failure is not None
            raise HandoffError("account handoff failed; T3 was restarted") from failure
