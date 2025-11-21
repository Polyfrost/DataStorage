#!/usr/bin/env bash
set -euo pipefail

# Change to script's directory to make relative paths work
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
URL="https://nightly.link/Polyfrost/packwiz/workflows/go/main/Linux%2064-bit%20x86.zip"
ZIP="Linux-64-bit-x86.zip"

echo "Downloading and setting up packwiz"
wget -O "$ZIP" "$URL" && unzip -o "$ZIP" && chmod +x packwiz
mkdir -p generated

for version in mrpacks/*; do
  [ -d "$version" ] || continue
  parsed="${version#mrpacks/}"
  for bundle in "$version"/*; do
    [ -d "$bundle" ] || continue
    echo "Updating and bundling $bundle"
    (cd "$bundle" && ../../../packwiz update -a -y && ../../../packwiz modrinth export)
    export_file=$(ls "$bundle"/*.mrpack | head -n 1)
    name="${bundle/$version/}"; name="${name#/}"; name="${name,,}"
    echo "Moving $bundle"
    mv "$export_file" "generated/$name-$parsed.mrpack"
  done
done
