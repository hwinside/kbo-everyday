#!/usr/bin/env bash
# /players 마이팀 디폴트 게이트의 검증력 증명.
#
# 게이트가 GREEN 이라는 사실만으로는 아무것도 증명하지 못한다(lessons 2026-08-12:
# "게이트가 종단 실행 경로를 안 태우면 통과는 아무 뜻이 없다"). 실제 결함을 주입했을 때
# **그 결함에 대응하는 체크 라벨이** ❌ 로 찍혀야 그 GREEN 에 의미가 생긴다.
#
# 단순 non-zero exit 판정은 false-positive 다 — anchor drift / esbuild 실패 /
# playwright 미설치도 전부 non-zero 라, 게이트가 아무것도 못 잡아도 "검출 성공" 이 된다.
# 그래서 여기서는 기대 라벨의 semantic RED 만 센다.
#
# 주입 축 → 기대 RED 체크:
#   cookie   — 쿠키 폴백 제거(수정 전 코드)        → M2 (localStorage 소실 경로)
#   late     — 늦은 마이팀 구독 제거(수정 전 코드) → M3 (로그인 유저 경로)
#   touched  — 유저 조작 가드 제거                 → M6 (유저 선택 덮어씀)
#   urlwin   — URL 명시 필터 가드 제거             → M5 (딥링크 덮어씀)
#
# 실행: npm run qa:players-myteam:mutations
set -uo pipefail

FAILED=0

# BSD(macOS) 와 GNU(Actions ubuntu) 의 mktemp 문법 차이를 피하려고 명시 template 을 쓴다.
mk_log() { mktemp "${TMPDIR:-/tmp}/players-myteam-mut.XXXXXX"; }

expect_red() {
  case "$1" in
    cookie) echo "M2" ;;
    late) echo "M3" ;;
    touched) echo "M6" ;;
    urlwin) echo "M5" ;;
    *) echo "" ;;
  esac
}

for m in cookie late touched urlwin; do
  want="$(expect_red "$m")"
  log="$(mk_log)"
  if [ -z "$log" ] || [ ! -f "$log" ]; then
    echo "❌ mutation '$m' → 임시 로그 파일 생성 실패(mktemp)"
    FAILED=1
    continue
  fi
  MYTEAM_MUTATE="$m" MYTEAM_REQUIRE_BROWSER=1 \
    node scripts/qa/players-myteam-default-browser.mjs > "$log" 2>&1

  # ① 인프라 실패는 "결함 검출" 로 세지 않는다.
  if grep -qE "anchor drifted|SKIP: playwright|Build failed|Cannot find module" "$log"; then
    echo "❌ mutation '$m' → 인프라 실패(결함 검출 아님):"
    grep -E "anchor drifted|SKIP: playwright|Build failed|Cannot find module" "$log" | head -3
    FAILED=1
    rm -f "$log"
    continue
  fi

  # ② 기대한 체크 라벨이 ❌ 로 찍혔는지(semantic RED).
  if grep -q "❌ ${want} " "$log"; then
    echo "✅ mutation '$m' → ${want} RED"
  else
    echo "❌ mutation '$m' → ${want} 가 RED 가 아니다(게이트가 이 결함을 못 잡는다):"
    grep -E "^  (✅|❌)" "$log" | head -12
    FAILED=1
  fi
  rm -f "$log"
done

if [ "$FAILED" -ne 0 ]; then
  echo "FAIL players myteam mutations"
  exit 1
fi
echo "PASS players myteam mutations: 4/4 semantic RED"
