#!/usr/bin/env bash
# /players 정렬 브라우저 게이트의 검증력 증명.
#
# 게이트가 GREEN 이라는 사실만으로는 아무것도 증명하지 못한다(2026-08-12 lessons:
# "게이트가 종단 실행 경로를 안 태우면 통과는 아무 뜻이 없다"). 실제 결함을 주입했을 때
# RED 가 나오는지 확인해야 그 GREEN 에 의미가 생긴다.
#
# 주입 축:
#   race     — settle 게이트 제거 → 빈 counts 선렌더 + 늦은 응답 재정렬
#   toggle   — 가나다순 갈래를 인기순으로 되돌림 → 토글이 무의미해짐(원래 버그 재현)
#   fallback — 실패 경로 settle 제거(timeout·catch 둘 다) → 로딩에 갇힘
#
# 실행: npm run qa:players-sort:mutations
set -uo pipefail

FAILED=0
for m in race toggle fallback; do
  if PLAYERS_SORT_MUTATE="$m" node scripts/qa/players-sort-browser.mjs > /dev/null 2>&1; then
    echo "❌ mutation '$m' NOT detected — 게이트가 이 결함을 못 잡는다"
    FAILED=1
  else
    echo "✅ mutation '$m' → RED"
  fi
done

if [ "$FAILED" -ne 0 ]; then
  echo "FAIL players sort mutations: 게이트 검증력 부족"
  exit 1
fi
echo "PASS players sort mutations: 3/3 RED"
