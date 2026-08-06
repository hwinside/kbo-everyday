#!/usr/bin/env bash
# 하단 safe-area 게이트 검출력 증명 (mutation RED).
#
# 게이트가 GREEN 인 것만으로는 아무것도 증명하지 못한다. 대상 로직을 실제로
# 망가뜨렸을 때 RED 로 죽는지를 봐야 검출력이 있는 게이트다.
#
# 각 mutation 은 "이 결함이 다시 들어왔을 때"를 재현한다.
set -uo pipefail
cd "$(dirname "$0")/../.."

GATE="node scripts/qa/bottom-safe-inset-gate.mjs --static"
GLOBALS="src/styles/globals.css"
DM="src/app/(main)/messages/[conversationId]/page.tsx"
SHEET="src/components/auth/LoginSheet.tsx"
DIARY="src/components/my/VenueDiaryViewer.tsx"
ADDGAME="src/components/my/VenueDiaryAddGameSheet.tsx"

backup() { cp "$1" "/tmp/.mut-$(basename "$1").bak"; }
restore() { cp "/tmp/.mut-$(basename "$1").bak" "$1"; }

pass=0; fail=0
run_mut() {
  local name="$1"; shift
  local file="$1"; shift
  backup "$file"
  "$@"
  if $GATE >/dev/null 2>&1; then
    echo "  ❌ $name — 게이트가 결함을 못 잡음 (false-green)"
    fail=$((fail+1))
  else
    echo "  ✅ $name — RED"
    pass=$((pass+1))
  fi
  restore "$file"
}

echo "=== mutation RED 검증 ==="

# M1: .pb-safe 정의를 통째로 제거 → 사고 이전 상태(전 호출부 no-op)로 회귀
run_mut "M1 .pb-safe 정의 삭제" "$GLOBALS" \
  perl -0pi -e 's/\.pb-safe \{[^}]*\}//s' "$GLOBALS"

# M2: 정의는 남기되 env() 를 상수로 바꿔치기 → "정의됐지만 inset 을 안 먹는" 상태
run_mut "M2 .pb-safe 가 env() 대신 상수" "$GLOBALS" \
  perl -0pi -e 's/padding-bottom: calc\(var\(--pb-safe-base, 1\.25rem\) \+ env\(safe-area-inset-bottom, 0px\)\);/padding-bottom: 1.25rem;/' "$GLOBALS"

# M3: DM composer 에서만 pb-safe 제거 → 이번 P0 그 자체.
#     A-2 (bottom-0 검색) 로는 못 잡고 A-2b (풀스크린 컬럼 하단 바) 가 잡아야 한다.
run_mut "M3 DM composer 의 pb-safe 만 제거" "$DM" \
  perl -pi -e 's/bg-bg-secondary pb-safe \[--pb-safe-base:0\.75rem\]/bg-bg-secondary/g' "$DM"

# M4: 바텀시트에서 pb-safe 제거 → A-2 가 잡아야 한다
run_mut "M4 LoginSheet 의 pb-safe 제거" "$SHEET" \
  perl -pi -e 's/p-5 pb-safe/p-5/' "$SHEET"

# M5: 변수 기반 보정(VenueDiaryViewer safeBottom)에서 env() 제거.
#     삼항연산자 한쪽 분기만 죽이므로 "선언 어딘가에 env 있음" 로 통과시키면 false-green.
run_mut "M5 safeBottom 변수에서 env() 제거" "$DIARY" \
  perl -pi -e 's/"max\(env\(safe-area-inset-bottom, 0px\), 48px\)"/"48px"/' "$DIARY"

# M6: 바텀시트(`fixed inset-0 items-end`)의 최하단 스크롤러에서 inset 제거.
#     이 시트는 `bottom-0` 을 안 쓰고 부모 `items-end` 로 밀려붙으므로
#     A-2/A-2b 로는 원천적으로 안 잡힐다 — A-2c 가 잡아야 한다.
run_mut "M6 바텀시트 최하단 스크롤러 inset 제거" "$ADDGAME" \
  perl -pi -e 's/pb-safe \[--pb-safe-base:1rem\] flex flex-col gap-2\.5/pb-4 flex flex-col gap-2.5/' "$ADDGAME"

echo
echo "RED $pass / false-green $fail"
[ "$fail" -eq 0 ] || exit 1
