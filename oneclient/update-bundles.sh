#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
URL="https://nightly.link/Polyfrost/packwiz/workflows/go/main/Linux%2064-bit%20x86.zip"
ZIP="Linux-64-bit-x86.zip"

echo "Downloading and setting up packwiz"
wget -O "$ZIP" "$URL" && unzip -o "$ZIP" && chmod +x packwiz

for version in mrpacks/*; do
  [ -d "$version" ] || continue
  parsed="${version#mrpacks/}"
  for bundle in "$version"/*; do
    [ -d "$bundle" ] || continue
    echo "Updating $bundle"
    (cd "$bundle" && ../../../packwiz update -a -y)
  done
done
