#!/usr/bin/env bash
# /players 정렬 브라우저 게이트의 검증력 증명.
#
# 게이트가 GREEN 이라는 사실만으로는 아무것도 증명하지 못한다(2026-08-12 lessons:
# "게이트가 종단 실행 경로를 안 태우면 통과는 아무 뜻이 없다"). 실제 결함을 주입했을 때
# **그 결함에 대응하는 체크가** RED 가 나와야 그 GREEN 에 의미가 생긴다.
#
# ⚠️ 단순 non-zero exit 판정은 false-positive 다(삼순 2026-08-15 NO-GO ③):
#   anchor drift throw · esbuild 실패 · playwright 미설치 · 오타로 인한 SyntaxError
#   전부 non-zero 라, 게이트가 결함을 전혀 못 잡아도 "검출 성공" 으로 세어진다.
#   그래서 여기서는 **기대한 체크 라벨이 ❌ 로 찍혔는지** 를 본다(semantic RED).
#
# 주입 축 → 기대 RED 체크:
#   race       — settle 게이트 제거              → B2a (빈 counts 선렌더)
#   toggle     — 가나다순을 인기순으로 되돌림     → B4  (토글 무의미 = 원래 버그 재현)
#   fallback   — 실패 settle 제거(timeout+catch) → B2c (timeout 확정 실패)
#   teamfilter — 구단별 필터 무력화               → B8  (필터가 목록을 안 줄임)
#   urlsort    — 구 sort 파라미터 URL 잔존        → B9  (URL 정규화 실패)
#
# 실행: npm run qa:players-sort:mutations
set -uo pipefail

FAILED=0

# mutation 이름 → 반드시 RED 여야 하는 체크 라벨 prefix
expect_red() {
  case "$1" in
    race) echo "B2a" ;;
    toggle) echo "B4" ;;
    fallback) echo "B2c" ;;
    teamfilter) echo "B8" ;;
    urlsort) echo "B9" ;;
    *) echo "" ;;
  esac
}

for m in race toggle fallback teamfilter urlsort; do
  want="$(expect_red "$m")"
  log="$(mktemp -t players-sort-mut)"
  PLAYERS_SORT_MUTATE="$m" PLAYERS_SORT_REQUIRE_BROWSER=1 \
    node scripts/qa/players-sort-browser.mjs > "$log" 2>&1
  code=$?

  # ① 인프라 실패(anchor drift / 빌드 오류 / 브라우저 부재)는 "검출" 로 세지 않는다.
  if grep -qE "anchor drifted|SKIP: playwright|Build failed|Cannot find module" "$log"; then
    echo "❌ mutation '$m' → 인프라 실패(결함 검출 아님):"
    grep -E "anchor drifted|SKIP: playwright|Build failed|Cannot find module" "$log" | head -3
    FAILED=1
    rm -f "$log"
    continue
  fi

  # ② 게이트가 실제로 돌았다는 증거: 체크 라벨이 찍혀야 한다.
  if ! grep -qE "^  (✅|❌) B1 " "$log"; then
    echo "❌ mutation '$m' → 게이트가 체크를 실행하지 못했다(라벨 없음)"
    tail -5 "$log"
    FAILED=1
    rm -f "$log"
    continue
  fi

  # ③ semantic 판정: 기대한 체크가 ❌ 인가.
  if grep -qE "^  ❌ ${want}[a-z]? " "$log"; then
    if [ "$code" -eq 0 ]; then
      echo "❌ mutation '$m' → ${want} RED 인데 exit 0 (종료코드 결속 깨짐)"
      FAILED=1
    else
      echo "✅ mutation '$m' → ${want} RED"
    fi
  else
    echo "❌ mutation '$m' NOT detected — ${want} 가 RED 가 아니다(게이트가 이 결함을 못 잡는다)"
    grep -E "^  ❌" "$log" | head -3
    FAILED=1
  fi
  rm -f "$log"
done

if [ "$FAILED" -ne 0 ]; then
  echo "FAIL players sort mutations: 게이트 검증력 부족"
  exit 1
fi
echo "PASS players sort mutations: 5/5 semantic RED"
