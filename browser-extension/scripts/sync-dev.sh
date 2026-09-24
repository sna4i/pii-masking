#!/usr/bin/env bash
# browser-extension/ の現在の内容を dev/ に同期する。
#
# dev/ は Chrome に「パッケージ化されていない拡張機能」として読み込ませる
# ディレクトリ。WSL 上のパスを Windows 側の Chrome から
# \\wsl.localhost\Ubuntu\home\sna\workspace\pii-masking\dev として指定する。
#
# 手でコピーしていると必ず古くなる (実際 v1.4.1 のエンジン修正が
# 5 ファイル分反映されていなかった)。コードを変えたらこれを実行する。
#
#   bash browser-extension/scripts/sync-dev.sh
#
# 実行後は Chrome の拡張機能ページで「更新」を押すこと。
set -euo pipefail

cd "$(dirname "$0")/.."
SRC="$PWD"
DEST="$PWD/../dev"

mkdir -p "$DEST"

# rsync で差分同期。--delete で SRC に無いファイルは DEST からも消す。
# ドキュメントと Store 専用ファイルは拡張機能の動作に不要なので除外する。
#
# 除外パターンに注意: 単なる --exclude は「コピーしない」だけでなく
# 「--delete の対象からも外す」ため、DEST に居座ったゴミが消えない。
# 実際 dev/ に配布用 zip (5.4MB) が置き去りになっていた。
# --delete-excluded を付けて、除外対象も DEST から消す。
rsync -a --delete --delete-excluded \
  --exclude '*.md' \
  --exclude 'scripts/' \
  --exclude 'manifest.store.json' \
  --exclude '*.zip' \
  --exclude '.pytest_cache/' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  "$SRC/" "$DEST/"

VERSION="$(python3 -c 'import json; m=json.load(open("manifest.json")); print(m["version"], m.get("version_name",""))')"
echo "✓ dev/ を同期しました"
echo "  バージョン: $VERSION"
echo "  パス      : $DEST"
echo "  ファイル数: $(find "$DEST" -type f | wc -l)"
echo
echo "Chrome 側で chrome://extensions を開き、PII Guard の「更新」を押してください。"
