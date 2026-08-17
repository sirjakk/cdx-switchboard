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
cp -R "$repo_dir/src" "$data_root/"
cp "$repo_dir/cdx" "$data_root/cdx"
chmod +x "$data_root/cdx"
ln -sfn "$data_root/cdx" "$target"

echo "Installed $target"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "Add $bin_dir to PATH, then run: cdx doctor" ;;
esac
