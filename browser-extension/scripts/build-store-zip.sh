#!/usr/bin/env bash
# Build the Chrome Web Store submission zip.
# Excludes dev-only files (markdown, scripts/, tests, etc.)
set -euo pipefail

cd "$(dirname "$0")/.."

# Store 提出物は manifest.store.json のほうが正。dev の manifest.json は
# 名前・バージョン・host_permissions が審査に出せない内容なので、
# 一時的に差し替えて zip し、必ず元に戻す。
VERSION="$(python3 -c 'import json; print(json.load(open("manifest.store.json"))["version"])')"
OUT="../pii-guard-v${VERSION}.zip"

rm -f "$OUT"

BACKUP="$(mktemp)"
cp manifest.json "$BACKUP"
# どの経路で抜けても dev manifest を復元する。
trap 'cp "$BACKUP" manifest.json; rm -f "$BACKUP"' EXIT
cp manifest.store.json manifest.json

zip -r "$OUT" . \
  -x "*.md" \
  -x "scripts/*" \
  -x "test-*" \
  -x ".pytest_cache/*" \
  -x "engine/__pycache__/*" \
  -x ".playwright-mcp/*" \
  -x "*.pyc" \
  -x "manifest.store.json"

echo
echo "✓ Built: $OUT"
echo "  Size: $(du -h "$OUT" | awk '{print $1}')"
echo "  Files: $(unzip -l "$OUT" | tail -1 | awk '{print $2}')"
echo
echo "Upload at: https://chrome.google.com/webstore/devconsole"
