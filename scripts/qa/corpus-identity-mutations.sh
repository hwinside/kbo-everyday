#!/usr/bin/env bash
#
# `qa:baseball-corpus-identity` 게이트의 **검출력 증명** — 결함주입 runner.
#
# ⚠️ 왜 커밋하는가: "mutation RED 확인했다"는 말은 커밋에 없으면 재현 불가능한 주장이다.
#   실제로 이 PR 작업 중 처음엔 5종이 **전부 GREEN** 이었다(fixture 만 늘리고 assert 를
#   안 해서 검출력이 0이었다). 게이트가 결함을 잡는지는 누구나 돌려 확인할 수 있어야 한다.
#
# 계약: 각 변이는 배포 소스를 실제로 훼손하고, 게이트가 RED 여야 통과다.
#       변이가 파일을 못 바꾸면(패턴 낡음) 그것도 실패로 본다. EXIT trap 으로 항상 복원.
#
# 실행: bash scripts/qa/corpus-identity-mutations.sh
set -uo pipefail
T="src/lib/baseball-qa/rag/corpus-identity.ts"
if [ ! -f "$T" ]; then echo "❌ repo 루트에서 실행해야 한다"; exit 1; fi
BK="$(mktemp -t corpus-identity-bak)"
cp "$T" "$BK"
trap 'cp "$BK" "$T"; rm -f "$BK"' EXIT
fail=0; pass=0
run(){ local n="$1"; shift
  for e in "$@"; do perl -0pi -e "$e" "$T"; done
  if diff -q "$BK" "$T" >/dev/null; then echo "❌ $n → 변이가 소스를 못 바꿨다(패턴 낡음)"; fail=$((fail+1)); cp "$BK" "$T"; return; fi
  if npm run -s qa:baseball-corpus-identity >/tmp/ci-mut-out.txt 2>&1; then echo "❌ $n → GREEN (게이트가 못 잡는다)"; fail=$((fail+1)); else echo "✅ $n → RED"; pass=$((pass+1)); fi
  cp "$BK" "$T"; }

run "C-A 분류 스캔 300자 캡 복귀" 's/\/분류\(\[\^\\n\]\*\)\//\/분류([^\\n]{0,300})\//'
run "C-B 해경계 구제 제거" 's/if \(!isYearBoundaryBirthDate\(documentBirthDate, input\.rosterBirthDate\)\) \{/if (true) {/'
run "C-C 1년차 제약 제거(2년도 허용)" 's/if \(Math\.abs\(documentBirthDate\.year - rosterYear\) !== 1\) return false;/if (Math.abs(documentBirthDate.year - rosterYear) > 2) return false;/'
run "C-D 해경계 월 요구 제거" 's/if \(!boundary\(documentBirthDate\.month\) \|\| !boundary\(rosterMonth\)\) return false;/\/\/ MUT-CD/'
run "C-E 60일 간격 제약 제거" 's/return Math\.abs\(docTime - rosterTime\) \/ 86_400_000 <= 60;/return true;/'
cp "$BK" "$T"
echo "----------------------------------------"
echo "RED ${pass} · 검출실패 ${fail}"
if ! diff -q "$BK" "$T" >/dev/null; then echo "❌ 원본 복원 실패"; exit 1; fi
if [ "$fail" -ne 0 ]; then echo "❌ mutation: 검출 실패 ${fail}건"; exit 1; fi
echo "✅ mutation: 전 축 RED (게이트 검출력 확인)"
