#!/bin/bash
# public/players-hero/*.webp 를 스캔해서 hero-approved-kboids.json 과 비교한다.
#
# 사용:
#   bash scripts/generate-hero-manifest.sh
#
# 동작:
#   - public/players-hero/ 의 webp 파일 목록과 allowlist를 비교
#   - allowlist에 없는 파일(미검수) / 파일 없는 allowlist 항목(누락) 감지
#   - allowlist를 직접 덮어쓰지 않음 — 검수 후 수동 추가 필요
#
# ⚠️  hero-approved-kboids.json은 검수 통과 선수만 포함하는 SSOT.
#     자동 등록 금지 — 반드시 삼순이 검수 후 추가.

set -eu
cd "$(dirname "$0")/.."

HERO_DIR="public/players-hero"
APPROVED="src/lib/constants/hero-approved-kboids.json"

if [ ! -d "$HERO_DIR" ]; then
  echo "❌ $HERO_DIR not found" >&2
  exit 1
fi

# 파일 기반 목록
FILE_IDS=$(ls "$HERO_DIR"/*.webp 2>/dev/null | sed 's|.*/||;s|\.webp$||' | sort -u)
FILE_COUNT=$(echo "$FILE_IDS" | wc -l | tr -d ' ')

# allowlist 기반 목록
APPROVED_IDS=$(jq -r '.[]' "$APPROVED" | sort -u)
APPROVED_COUNT=$(jq 'length' "$APPROVED")

# 비교
NOT_IN_APPROVED=$(comm -23 <(echo "$FILE_IDS") <(echo "$APPROVED_IDS"))
NOT_IN_FILES=$(comm -13 <(echo "$FILE_IDS") <(echo "$APPROVED_IDS"))

echo "📊 Hero manifest check"
echo "   파일: ${FILE_COUNT}개 (public/players-hero/*.webp)"
echo "   allowlist: ${APPROVED_COUNT}개 (hero-approved-kboids.json)"

if [ -n "$NOT_IN_APPROVED" ]; then
  COUNT=$(echo "$NOT_IN_APPROVED" | wc -l | tr -d ' ')
  echo ""
  echo "⚠️  파일 있지만 allowlist 미등록 (${COUNT}명) — 검수 필요:"
  echo "$NOT_IN_APPROVED" | head -20
  if [ "$COUNT" -gt 20 ]; then
    echo "   ... 외 $((COUNT-20))명"
  fi
fi

if [ -n "$NOT_IN_FILES" ]; then
  COUNT=$(echo "$NOT_IN_FILES" | wc -l | tr -d ' ')
  echo ""
  echo "❌ allowlist에 있지만 파일 누락 (${COUNT}명):"
  echo "$NOT_IN_FILES" | head -20
  if [ "$COUNT" -gt 20 ]; then
    echo "   ... 외 $((COUNT-20))명"
  fi
fi

if [ -z "$NOT_IN_APPROVED" ] && [ -z "$NOT_IN_FILES" ]; then
  echo ""
  echo "✅ 파일과 allowlist 완벽 일치 (${APPROVED_COUNT}명)"
fi
