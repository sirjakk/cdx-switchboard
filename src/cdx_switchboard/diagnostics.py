"""Inspect actual executable selection without reading login credentials."""

import os
from pathlib import Path
import shutil
import subprocess

from .codex import CodexError, client_environment


def codex_version(binary: str) -> str:
    try:
        result = subprocess.run([binary, "--version"], env=client_environment(),
                                capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CodexError(f"could not read Codex version at {binary}") from exc
    if result.returncode or not result.stdout.strip().startswith("codex-cli "):
        raise CodexError(f"could not read Codex version at {binary}")
    return result.stdout.strip().splitlines()[0]


def alternate_binaries(binary: str, search_path: str | None = None) -> list[str]:
    """Report distinct installations, collapsing symlinks to the same target."""
    selected = Path(shutil.which(binary) or binary).resolve()
    seen = {selected}
    found = []
    for directory in (os.environ.get("PATH", "") if search_path is None else search_path).split(os.pathsep):
        candidate = Path(directory or ".") / "codex"
        if candidate.is_file() and os.access(candidate, os.X_OK):
            resolved = candidate.resolve()
            if resolved not in seen:
                found.append(str(candidate.absolute()))
                seen.add(resolved)
    return found
