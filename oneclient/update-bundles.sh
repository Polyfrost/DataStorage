#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

PACKWIZ_BIN=""

download_file() {
  local url="$1"
  local out="$2"
  if command -v wget >/dev/null 2>&1; then
    wget -O "$out" "$url"
  elif command -v curl >/dev/null 2>&1; then
    curl -L -o "$out" "$url"
  else
    echo "Error: Neither wget nor curl is installed; cannot download packwiz." >&2
    exit 1
  fi
}

if command -v packwiz >/dev/null 2>&1; then
  PACKWIZ_BIN="$(command -v packwiz)"
  echo "Using packwiz from PATH: $PACKWIZ_BIN"
elif [[ "$(uname -s)" == "Linux" ]]; then
  if ! command -v unzip >/dev/null 2>&1; then
    echo "Error: unzip is required to set up packwiz." >&2
    exit 1
  fi
  echo "packwiz not found in PATH, downloading Linux fallback"
  URL="https://nightly.link/Polyfrost/packwiz/workflows/go/main/Linux%2064-bit%20x86.zip"
  ZIP="Linux-64-bit-x86.zip"
  download_file "$URL" "$ZIP"
  unzip -o "$ZIP"
  chmod +x packwiz
  PACKWIZ_BIN="$(pwd)/packwiz"
else
  echo "Error: packwiz not found in PATH on $(uname -s). Install packwiz and rerun." >&2
  exit 1
fi

for version in mrpacks/*; do
  [ -d "$version" ] || continue
  parsed="${version#mrpacks/}"
  for bundle in "$version"/*; do
    [ -d "$bundle" ] || continue
    echo "Updating $bundle"
    (cd "$bundle" && "$PACKWIZ_BIN" update -a -y)
  done
done
