#!/usr/bin/env bash
# Makes the release zip that users install: one folder with everything Decky needs, no build step.
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(node -p "require('./package.json').version")
OUT="release"; DIR="$OUT/steamder"
rm -rf "$OUT"; mkdir -p "$DIR/dist"
cp plugin.json package.json main.py LICENSE README.md "$DIR/"
cp dist/index.js "$DIR/dist/"
( cd "$OUT" && zip -qr "Steamder-v$VER.zip" steamder )
echo "$OUT/Steamder-v$VER.zip"
