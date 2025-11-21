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
    export_files=("$bundle"/*.mrpack)
    if [[ ${#export_files[@]} -ne 1 ]] || [[ ! -f "${export_files[0]}" ]]; then
        echo "Error: Expected 1 .mrpack file in '$bundle', but found ${#export_files[@]}. Skipping." >&2
        continue
    fi
    export_file="${export_files[0]}"

    name=$(basename "$bundle")
    name="${name,,}"
    echo "Moving '$export_file' to 'generated/$name-$parsed.mrpack'"
    mv "$export_file" "generated/$name-$parsed.mrpack"
  done
done
