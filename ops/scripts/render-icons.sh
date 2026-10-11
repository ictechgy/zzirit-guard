#!/bin/zsh
# 로고 SVG에서 PWA 아이콘(PNG)을 만든다. macOS의 qlmanage로 렌더링한다.
# 사용법: ops/scripts/render-icons.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SOURCE="$ROOT/assets/logo/zzirit-guard-mark.svg"
OUT="$ROOT/apps/web/public/icons"
WORK=$(mktemp -d)
mkdir -p "$OUT"
cp "$SOURCE" "$OUT/logo.svg"
for SIZE in 180 192 512; do
  /usr/bin/qlmanage -t -s "$SIZE" -o "$WORK" "$SOURCE" >/dev/null
  mv "$WORK/zzirit-guard-mark.svg.png" "$OUT/icon-$SIZE.png"
done
mv "$OUT/icon-180.png" "$OUT/apple-touch-icon.png"
rm -rf "$WORK"
echo "아이콘을 만들었습니다: $OUT"
