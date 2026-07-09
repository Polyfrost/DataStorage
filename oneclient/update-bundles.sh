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

# packwiz exits 0 even when Modrinth answers 429 (rate limit) — it just prints
# "Failed to check updates for <mod>: ... 429" and leaves that mod at its old
# version. When that happens to only some categories, the same mod ends up
# pinned to different versions across bundles, which the compat gate then
# (correctly) rejects. So treat a 429 in the output as a soft failure and retry
# the whole bundle with exponential backoff, and pace requests between bundles.
MAX_ATTEMPTS="${PACKWIZ_UPDATE_MAX_ATTEMPTS:-6}"
INTER_BUNDLE_SLEEP="${PACKWIZ_UPDATE_SLEEP:-3}"

update_bundle() {
  local bundle="$1"
  local attempt=1 out wait
  while (( attempt <= MAX_ATTEMPTS )); do
    out="$( (cd "$bundle" && "$PACKWIZ_BIN" update -a -y --stable) 2>&1 )" || true
    printf '%s\n' "$out"
    if ! grep -q '429' <<<"$out"; then
      return 0
    fi
    wait=$(( 20 * 2 ** (attempt - 1) ))
    (( wait > 300 )) && wait=300
    echo "::warning::Rate limited (HTTP 429) updating $bundle; retry ${attempt}/${MAX_ATTEMPTS} after ${wait}s" >&2
    sleep "$wait"
    (( attempt++ ))
  done
  echo "::error::Still rate limited (HTTP 429) updating $bundle after ${MAX_ATTEMPTS} attempts; aborting to avoid an inconsistent partial update" >&2
  return 1
}

for version in mrpacks/*; do
  [ -d "$version" ] || continue
  parsed="${version#mrpacks/}"
  for bundle in "$version"/*; do
    [ -d "$bundle" ] || continue
    echo "Updating $bundle"
    update_bundle "$bundle"
    sleep "$INTER_BUNDLE_SLEEP"
  done
done
