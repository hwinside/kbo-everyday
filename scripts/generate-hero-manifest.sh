#!/bin/bash
# public/players-hero/*.webp 를 스캔해서 src/lib/constants/hero-kboids.json 을 재생성한다.
#
# 사용:
#   bash scripts/generate-hero-manifest.sh
#
# 동작:
#   - public/players-hero 디렉토리의 *.webp 파일명(확장자 제외)을 kboId로 모음
#   - 숫자 kboId (오름차순) + 영숫자 kboId (AQ001 등) 전부 포함, 중복 제거
#   - JSON 배열로 src/lib/constants/hero-kboids.json 에 기록
#
# 신규 선수 cutout webp를 public/players-hero/ 에 추가한 뒤 이 스크립트를 실행해
# PlayerHero.tsx 의 HERO_KBOIDS 매핑을 갱신한다.

set -eu
cd "$(dirname "$0")/.."

HERO_DIR="public/players-hero"
OUT="src/lib/constants/hero-kboids.json"

if [ ! -d "$HERO_DIR" ]; then
  echo "❌ $HERO_DIR not found" >&2
  exit 1
fi

COUNT=$(ls "$HERO_DIR"/*.webp 2>/dev/null | wc -l | tr -d ' ')
if [ "$COUNT" -eq 0 ]; then
  echo "❌ no webp files in $HERO_DIR" >&2
  exit 1
fi

ls "$HERO_DIR"/*.webp \
  | sed 's|.*/||;s|\.webp$||' \
  | sort -u \
  | jq -R -s 'split("\n") | map(select(length > 0))' \
  > "$OUT"

TOTAL=$(jq 'length' "$OUT")
echo "✅ wrote $OUT ($TOTAL entries)"
