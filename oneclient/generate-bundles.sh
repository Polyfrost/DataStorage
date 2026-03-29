#!/usr/bin/env bash
set -euo pipefail

echo "Checking for required deps"
for cmd in zip unzip; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: Required command '$cmd' is not installed or not in PATH." >&2
    exit 1
  fi
done

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

echo "Creating required paths"
mkdir -p generated
export_dir="generated/export"

for version in mrpacks/*; do
  [ -d "$version" ] || continue
  parsed="${version#mrpacks/}"
  for bundle in "$version"/*; do
    [ -d "$bundle" ] || continue
    echo "Bundling $bundle"
    name=$(basename "$bundle")
    name="${name,,}"
    output="generated/$name-$parsed.mrpack"
    (cd "$bundle" && "$PACKWIZ_BIN" modrinth export --output "../../../$output")

    # Rezip it so the sorting is the same every time
    # Reset all the timestamps to 0 (unix) so they don't change
    echo "Fixing Bundle $bundle"
    rm -rf "$export_dir"
    mkdir -p "$export_dir"
    unzip -q "$output" -d "$export_dir"
    rm "$output"
    find "$export_dir" -exec touch -h -d '@0' {} +
    (cd "$export_dir" && LC_ALL=C find . -print | sort | zip -X -q -@ "../$(basename "$output")")
    rm -rf "$export_dir"
  done
done

