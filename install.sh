#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
data_root="${XDG_DATA_HOME:-$HOME/.local/share}/cdx-switchboard/app"
bin_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
target="$bin_dir/cdx"

if [[ -e "$target" || -L "$target" ]]; then
  existing="$(readlink "$target" 2>/dev/null || true)"
  if [[ "$existing" != "$data_root/cdx" ]]; then
    echo "Refusing to overwrite existing command: $target" >&2
    echo "Move it aside explicitly, then rerun this installer." >&2
    exit 1
  fi
fi

mkdir -p "$data_root" "$bin_dir"
wrapper="$bin_dir/cdx-codex"
if [[ -e "$wrapper" || -L "$wrapper" ]]; then
  if [[ "$(readlink "$wrapper" 2>/dev/null || true)" != "$data_root/cdx-codex" ]]; then
    echo "Refusing to overwrite existing command: $wrapper" >&2
    exit 1
  fi
fi
cp -R "$repo_dir/src" "$data_root/"
cp "$repo_dir/cdx" "$data_root/cdx"
python3 - "$repo_dir/cdx-codex" "$data_root/cdx-codex" <<'PY'
from pathlib import Path
import sys
source = Path(sys.argv[1]).read_text().splitlines(keepends=True)
Path(sys.argv[2]).write_text("#!" + sys.executable + "\n" + "".join(source[1:]))
PY
chmod +x "$data_root/cdx"
chmod +x "$data_root/cdx-codex"
ln -sfn "$data_root/cdx" "$target"
ln -sfn "$data_root/cdx-codex" "$wrapper"

echo "Installed $target"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "Add $bin_dir to PATH, then run: cdx doctor" ;;
esac
