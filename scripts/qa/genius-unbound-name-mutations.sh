#!/usr/bin/env bash
#
# `qa:genius-unbound-name` 게이트의 **검출력 증명** — 결함주입 runner.
#
# ⚠️ 왜 스크립트로 커밋하는가 (삼순 2026-08-08):
#   "mutation 7종 RED 확인했다"는 말은 커밋에 남지 않으면 재현 불가능한 주장이다.
#   게이트가 실제로 결함을 잡는지는 **누구나 이 스크립트를 돌려** 확인할 수 있어야 한다.
#   (게이트가 GREEN 인데 대상 로직이 죽어도 안 잡히는 false-green 이 이 PR 트랙에서
#    반복해서 나왔다 — 그래서 검출력 자체를 산출물로 만든다.)
#
# 계약: 각 변이는 **배포 소스**(`src/lib/baseball-qa/pipeline.ts`)를 실제로 훼손하고,
#       게이트가 RED 로 떨어져야 통과다. GREEN 이면 그 축은 검출력이 0이다.
#       원본은 시작 시 백업하고 매 변이 후 복원한다(EXIT trap 으로 중단 시에도 복원).
#
# 실행: bash scripts/qa/genius-unbound-name-mutations.sh
set -uo pipefail

TARGET="src/lib/baseball-qa/pipeline.ts"
BACKUP="$(mktemp -t unbound-name-pipeline)"
LOG="$(mktemp -t unbound-name-mutlog)"

if [ ! -f "$TARGET" ]; then
  echo "❌ $TARGET 이 없다 — repo 루트에서 실행해야 한다"
  exit 1
fi

cp "$TARGET" "$BACKUP"
restore() { cp "$BACKUP" "$TARGET"; }
trap 'restore; rm -f "$BACKUP" "$LOG"' EXIT

fail=0
pass=0

run_mutation() {
  local name="$1"
  shift
  # 변이 적용 (perl 표현식들)
  for expr in "$@"; do
    perl -0pi -e "$expr" "$TARGET"
  done
  # 변이가 실제로 파일을 바꿨는지 확인 — 안 바뀌면 그 변이는 무의미하다(가짜 RED 방지)
  if diff -q "$BACKUP" "$TARGET" >/dev/null; then
    echo "❌ $name → 변이가 소스를 바꾸지 못했다 (패턴이 낡음)"
    fail=$((fail + 1))
    restore
    return
  fi
  if npm run -s qa:genius-unbound-name >"$LOG" 2>&1; then
    echo "❌ $name → GREEN (게이트가 이 결함을 못 잡는다)"
    fail=$((fail + 1))
  else
    echo "✅ $name → RED : $(grep -m1 'FAIL:' "$LOG" | head -c 120)"
    pass=$((pass + 1))
  fi
  restore
}

echo "=== genius-unbound-name mutation runner ==="

# N-A: fail-close 자체 제거 — 미결속 실명이 generic LLM 으로 그대로 간다(원래 사고).
run_mutation "N-A fail-close 제거" \
  's/if \(resolveUnboundName\(question, players\) !== null\) return "name_suggest";/\/\/ MUT-NA/'

# N-B: 후보 1명 제한 해제 — 여럿 중 아무나 제안(엉뚱한 선수를 들이민다).
run_mutation "N-B 후보 1명 제한 해제" \
  's/suggestion: candidates\.length === 1 \? candidates\[0\] : null/suggestion: candidates[0] ?? null/'

# N-C: 1차 구현으로 되돌리기 — "이웃이 있을 때만" 막는다(삼순 P0-1 이 지적한 그 구멍).
run_mutation "N-C near-miss 만 막는 1차 구현 복귀" \
  's/return \{ token, suggestion: candidates\.length === 1 \? candidates\[0\] : null \};/if (candidates.length !== 1) return null; return { token, suggestion: candidates[0] };/'

# N-D: quota 반환 제거 — 오타 한 글자에 하루 한도를 두 배로 물린다.
run_mutation "N-D quota 반납 제거" \
  's/if \(route === "name_suggest" && deps\.releaseDaily\) \{/if (false \&\& deps.releaseDaily) {/'

# N-E: 사람 신호 요구 제거 — 룰 질문(`우천 취소 기준`)이 이름 되묻기로 샌다.
run_mutation "N-E 사람 신호 요구 제거" \
  's/if \(!hasPersonWord && !headHasSubjectParticle\) return null;/\/\/ MUT-NE/'

# N-F: 성씨 결속 제거 — 성씨가 아닌 아무 3음절이나 이름이 된다.
run_mutation "N-F 성씨 결속 제거" \
  's/if \(!surnames\.has\(token\[0\]\)\) continue;/\/\/ MUT-NF/'

# N-G: 첫 어절 제약 제거 — 문장 전체를 훑어 구단 서술 질문(`창단 이야기`)이 죽는다.
run_mutation "N-G 첫 어절 제약 제거" \
  's/const cores = \[\.\.\.new Set\(stripTokenSuffix\(headRaw\)\)\]\.sort\(\(a, b\) => a\.length - b\.length\);/const cores = [...new Set(tokens.flatMap((t) => stripTokenSuffix(t)))].sort((a, b) => a.length - b.length);/'

# N-H: 한국 성씨 폐쇄집합 제거 — 현역에 없는 성씨(`선동열`)가 다시 누수된다(삼순 P0-1).
run_mutation "N-H 한국 성씨 폐쇄집합 제거" \
  's/const surnames = new Set\(\[\.\.\.KOREAN_SURNAMES, \.\.\.rosterNames\.map\(\(name\) => name\[0\]\)\]\);/const surnames = new Set(rosterNames.map((name) => name[0]));/'

# N-I: 조사 붙은 형태 허용 — 일반명사 주어(`김치는`)가 이름이 된다(삼순 P0-2).
run_mutation "N-I 조사형 배제 제거" \
  's/if \(SUBJECT_PARTICLES\.some\(\(particle\) => token\.endsWith\(particle\)\)\) continue;/\/\/ MUT-NI/'

# N-J — **동등변이**로 판정해 제외했다 (검출 실패가 아니다).
#
#   "핵 우선 정렬(`a.length - b.length`)을 뒤집는" 변이를 넣었는데 게이트가 GREEN 이었다.
#   원인을 파보니 게이트 결손이 아니라 **정렬이 이미 결과를 바꿀 수 없는 상태**였다:
#     `임창규는 어느 팀이야` → 분해형 [`임창규는`, `임창규`]
#     조사형 배제(N-I 축)가 `임창규는` 를 먼저 걸러내므로 정렬 방향과 무관하게
#     남는 후보는 `임창규` 하나다(오름·내림 둘 다 `['임창규']` 실측).
#   즉 이 변이는 프로그램 행동을 바꿀지 않는 동등변이라 어떤 게이트로도 RED 가 될 수 없다.
#   그 축의 진짜 방어는 N-I(조사형 배제)가 이미 RED 로 증명한다.
#   ⚠️ "게이트가 못 잡는다"와 "변이가 행동을 안 바꿈"을 구분해야 한다 — 전자만 결손이다.

# N-K: 2음절 허용 — `김치`·`안타` 같은 일반명사가 이름 후보가 된다.
run_mutation "N-K 음절 하한 완화" \
  's/if \(token\.length < 3 \|\| token\.length > 4\) continue;/if (token.length < 2 || token.length > 4) continue;/'

# N-L: 기능어 전체 배제 제거 — `저번에` 같은 조사 붙은 지시어가 길이 하한을 우회한다.
run_mutation "N-L 기능어 분해형 배제 제거" \
  's/if \(cores\.some\(\(core\) => NON_NAME_FUNCTION_WORDS\.has\(core\)\)\) return null;/\/\/ MUT-NL/'

echo "----------------------------------------"
echo "RED ${pass} · 검출실패 ${fail}"

# 원본 무결성 확인 — 스크립트가 소스를 오염시킨 채 끝나면 안 된다.
restore
if ! diff -q "$BACKUP" "$TARGET" >/dev/null; then
  echo "❌ 원본 복원 실패"
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo "❌ mutation: 검출 실패 ${fail}건 — 게이트가 그 축을 보지 못한다"
  exit 1
fi
echo "✅ mutation: 전 축 RED (게이트 검출력 확인)"
