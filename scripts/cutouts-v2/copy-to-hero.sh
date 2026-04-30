#!/bin/bash
# v2 산출물을 players-hero/ 로 안전하게 복사하는 가드 스크립트.
#
# ⚠️  직접 cp/mv 금지 — 반드시 이 스크립트를 통해 복사.
#     allowlist에 등록된 kboId만 복사하고, 미등록 파일은 차단.
#
# 사용:
#   bash scripts/cutouts-v2/copy-to-hero.sh              # 전체 allowlist 기준 동기화
#   bash scripts/cutouts-v2/copy-to-hero.sh 50007 50030   # 지정 kboId만 복사
#   DRY_RUN=1 bash scripts/cutouts-v2/copy-to-hero.sh     # 미리보기 (실제 복사 안 함)

set -eu
cd "$(dirname "$0")/../.."

V2_DIR="public/players-hero-v2/webp"
HERO_DIR="public/players-hero"
APPROVED="src/lib/constants/hero-approved-kboids.json"

if [ ! -f "$APPROVED" ]; then
  echo "❌ allowlist not found: $APPROVED" >&2
  exit 1
fi

DRY_RUN="${DRY_RUN:-0}"
APPROVED_SET=$(jq -r '.[]' "$APPROVED")

copy_count=0
skip_count=0
block_count=0
blocked_ids=""

# 대상 kboId 결정
if [ $# -gt 0 ]; then
  TARGET_IDS="$@"
else
  # v2 webp 전체
  TARGET_IDS=$(ls "$V2_DIR"/*.webp 2>/dev/null | sed 's|.*/||;s|\.webp$||' | sort -u)
fi

for kbo_id in $TARGET_IDS; do
  src="$V2_DIR/${kbo_id}.webp"

  if [ ! -f "$src" ]; then
    echo "⚠️  SKIP (no v2 file): $kbo_id"
    skip_count=$((skip_count+1))
    continue
  fi

  # allowlist 체크
  if echo "$APPROVED_SET" | grep -qx "$kbo_id"; then
    if [ "$DRY_RUN" = "1" ]; then
      echo "📋 DRY: would copy $kbo_id"
    else
      cp "$src" "$HERO_DIR/${kbo_id}.webp"
    fi
    copy_count=$((copy_count+1))
  else
    echo "🚫 BLOCKED (not in allowlist): $kbo_id"
    blocked_ids="$blocked_ids $kbo_id"
    block_count=$((block_count+1))
  fi
done

echo ""
echo "=========================================="
if [ "$DRY_RUN" = "1" ]; then
  echo "DRY RUN (실제 복사 없음)"
fi
echo "복사: ${copy_count}, 스킵: ${skip_count}, 차단: ${block_count}"
if [ $block_count -gt 0 ]; then
  echo "차단된 ID:$blocked_ids"
  echo ""
  echo "⚠️  차단된 파일은 삼순이 검수 후 allowlist에 추가해야 복사 가능합니다."
fi
echo "=========================================="

if [ $block_count -gt 0 ]; then
  exit 1
fi
