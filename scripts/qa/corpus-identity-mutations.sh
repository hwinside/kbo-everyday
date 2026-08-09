#!/usr/bin/env bash
#
# `qa:baseball-corpus-identity` 게이트의 **검출력 증명** — 결함주입 runner.
#
# ⚠️ 왜 이 형태인가 (삼순 NO-GO ④): 종전 runner 는 **아무 nonzero exit** 를 RED 로 셌다.
#   그러면 변이가 만든 컴파일 오류·모듈 로드 실패까지 "검출 성공" 이 된다. 게이트가 실제로
#   그 결함을 *판정으로* 잡았는지는 증명되지 않는다.
#
#   그래서 변이마다 **어떤 assertion 이 깨져야 하는지**를 지정하고, 게이트 출력에 그 문구가
#   있을 때만 RED 로 센다. 컴파일 오류는 그 문구를 만들지 못하므로 실패로 분류된다.
#
# 계약:
#   - 변이는 배포 소스를 실제로 훼손해야 한다(못 바꾸면 패턴이 낡은 것 → 실패).
#   - 게이트는 non-zero 로 끝나야 한다.
#   - 게이트 출력에 **지정한 assertion 문구**가 있어야 한다.
#   - EXIT trap 으로 항상 원본 복원.
#
# 실행: bash scripts/qa/corpus-identity-mutations.sh   (npm run qa:baseball-corpus-identity:mutations)
set -uo pipefail

TARGET="src/lib/baseball-qa/rag/corpus-identity.ts"
if [ ! -f "$TARGET" ]; then echo "❌ repo 루트에서 실행해야 한다"; exit 1; fi

BACKUP="$(mktemp -t corpus-identity-bak)"
OUT="$(mktemp -t corpus-identity-mut-out)"
cp "$TARGET" "$BACKUP"
trap 'cp "$BACKUP" "$TARGET"; rm -f "$BACKUP" "$OUT"' EXIT

fail=0
pass=0

# run <이름> <기대 assertion 문구> <perl 표현식...>
run() {
  local name="$1"; shift
  local expect="$1"; shift
  for expression in "$@"; do perl -0pi -e "$expression" "$TARGET"; done
  if diff -q "$BACKUP" "$TARGET" >/dev/null; then
    echo "❌ ${name} → 변이가 소스를 못 바꿨다(패턴 낡음)"
    fail=$((fail + 1)); cp "$BACKUP" "$TARGET"; return
  fi
  if npm run -s qa:baseball-corpus-identity >"$OUT" 2>&1; then
    echo "❌ ${name} → GREEN (게이트가 못 잡는다)"
    fail=$((fail + 1)); cp "$BACKUP" "$TARGET"; return
  fi
  if ! grep -qF -- "$expect" "$OUT"; then
    echo "❌ ${name} → non-zero 지만 기대 assertion 이 아니다"
    echo "     기대: ${expect}"
    echo "     실제: $(grep -m3 -E 'AssertionError|Error:|error TS' "$OUT" | tr '\n' ' ' | cut -c1-220)"
    fail=$((fail + 1)); cp "$BACKUP" "$TARGET"; return
  fi
  echo "✅ ${name} → RED (${expect})"
  pass=$((pass + 1)); cp "$BACKUP" "$TARGET"
}

# ── A. 레이아웃 축 ─────────────────────────────────────────────────────────
run "A-1 listed 레이아웃 파싱 제거(한 줄 파서로 회귀)" \
  "listed 레이아웃이다" \
  's/if \(labels\.length === 0\) return \{ layout: "absent", labels: \[\] \};\n  return \{ layout: "listed", labels \};/return { layout: "absent", labels: [] };/'

run "A-2 listed 라벨 블록 조기 종료(첫 줄만)" \
  "listed 라벨 블록이" \
  's/const stop = Math\.min\(lines\.length, markerIndex \+ 1 \+ CATEGORY_LISTED_MAX_LINES\);/const stop = Math.min(lines.length, markerIndex + 2);/'

run "A-3 listed 라벨 블록 무제한 확장(본문까지 흡수)" \
  "라벨 블록이 본문까지 먹었다" \
  's/if \(!isCorpusCategoryLabelLine\(lines\[index\]\)\) break;/if (lines[index].trim().length === 0) break;/'

run "A-4 분류 스캔 줄 상한 축소(분류 줄을 못 찾음)" \
  "김도영은 inline 레이아웃이다" \
  's/const CATEGORY_HEAD_LINES = 40;/const CATEGORY_HEAD_LINES = 3;/'

# ⚠️ 긴 분류가 잘리는 건 **inline 레이아웃**의 문제다(양의지 428자, 한 줄).
#   listed 라벨 검사(`isCorpusCategoryLabelLine`)를 건드리면 이 축을 못 건드린다 — 첫 시도가 실제로 GREEN 이었다.
run "A-5 inline 분류 300자 상한 복귀(양의지 잘림)" \
  "스캔 상한이 되살아났다" \
  's/const inline = markerLine\.slice\(markerLine\.indexOf\("분류"\) \+ 2\)\.trim\(\);/const inline = markerLine.slice(markerLine.indexOf("분류") + 2).trim().slice(0, 300);/'

# ── B. 평탄화 fail-open 축 (삼순 NO-GO ②) ─────────────────────────────────
run "B-1 본문 마커 검사 제거(평탄화 문서를 분류로 읽음)" \
  "분류 줄이 본문을 삼켰는데 판정했다" \
  's/if \(hasBodyMarker\(inline\)\) return \{ layout: "unparseable", labels: \[\] \};//'

run "B-2 unparseable 을 통과로 처리" \
  "분류 줄이 본문을 삼켰는데 판정했다" \
  's/if \(layout === "unparseable"\) \{/if (false) {/'

# ── C. 생년 근거 축 (삼순 NO-GO ①) ────────────────────────────────────────
run "C-1 등록일 명시 요구 제거(무조건 구제)" \
  "구제 조건이 사라졌다" \
  's/if \(!documentStatesRosterBirthDate\(input\.text, input\.rosterBirthDate\)\) \{/if (false) {/'

run "C-2 근접일 휴리스틱 회귀(연도차 1이면 구제)" \
  "근접일 허용이 되살아났다" \
  's/export function documentStatesRosterBirthDate\(\n  text: string,\n  rosterBirthDate: string \| undefined,\n\): boolean \{/export function documentStatesRosterBirthDate(\n  text: string,\n  rosterBirthDate: string | undefined,\n): boolean {\n  if (rosterBirthDate) {\n    const clause = extractBirthClauseDate(text);\n    if (clause \&\& Math.abs(clause.year - Number(rosterBirthDate.slice(0, 4))) === 1) return true;\n  }/'

run "C-3 출생 clause 결속 해제(첫 날짜 아무거나)" \
  "출생 clause가 없는데 데뷔일을 생일로 읽었다" \
  's/const clauseIndex = lines\.findIndex\(\(line\) => line\.trim\(\) === "출생"\);\n  if \(clauseIndex < 0\) return undefined;/const clauseIndex = 0;/'

# ⚠️ listed 만 죽이는 변이여야 한다. 읽는 줄 수를 줄이면 inline(최형우: `\t` 다음 줄에 날짜)도 함께 죽어
#   어느 축이 깨졌는지 구분되지 않는다. 병합만 없애면 listed 의 쪼개진 날짜만 못 읽는다.
run "C-4 clause 줄바꿈 병합 제거(listed 쪼개진 날짜 못 읽음)" \
  "listed 출생 clause 를 읽지 못했다" \
  's/\.join\(""\);/.filter((line) => line.length > 0)[0] ?? "";/'

run "C-5 clause 부재 fail-close 제거" \
  "인포박스 생일이 없는데 구제했다" \
  's/if \(!extractBirthClauseDate\(input\.text\)\) \{/if (false) {/'

run "C-6 로스터 날짜 결측 시 통과" \
  "로스터 날짜 없이 통과했다" \
  's/if \(!rosterBirthDate\) return false;/if (!rosterBirthDate) return true;/'

# ── D. 신원 판정 순서·제목 축 ─────────────────────────────────────────────
run "D-1 동음이의 판정을 야구분류 뒤로(순서 붕괴)" \
  "동음이의 문서에 야구선수가 섞여 있는데 통과했다" \
  's/  if \(isAmbiguityDocument\(categories\)\) \{\n    \/\/ 버리는 게 아니라 격리한다 — 나중에 진짜 문서를 찾을 단서가 된다\.\n    return \{ ok: false, status: "ambiguous", reason: "ambiguity_document" \};\n  \}\n  if \(!hasBaseballPlayerCategory\(categories\)\) \{\n    return \{ ok: false, status: "rejected", reason: "not_baseball_player_document" \};\n  \}/  if (!hasBaseballPlayerCategory(categories)) {\n    return { ok: false, status: "rejected", reason: "not_baseball_player_document" };\n  }\n  if (isAmbiguityDocument(categories)) {\n    return { ok: false, status: "ambiguous", reason: "ambiguity_document" };\n  }/'

run "D-2 제목 대조 제거(타인 문서 오귀속)" \
  "다른 선수 문서에 도착했는데 통과했다" \
  's/  const matchedTitle = titleMatchesSeed\(input\.seedName, input\.documentTitle\);/  const matchedTitle = true;/'

run "D-3 분류 전체 대신 본문 전체로 야구선수 판정(fail-open)" \
  "성씨 문서가 본문 야구선수 링크로 통과했다" \
  's/  if \(!hasBaseballPlayerCategory\(categories\)\) \{/  if (!hasBaseballPlayerCategory(input.text)) {/'

cp "$BACKUP" "$TARGET"
echo "----------------------------------------"
echo "RED ${pass} · 검출실패 ${fail}"
if ! diff -q "$BACKUP" "$TARGET" >/dev/null; then echo "❌ 원본 복원 실패"; exit 1; fi
if [ "$fail" -ne 0 ]; then echo "❌ mutation: 검출 실패 ${fail}건"; exit 1; fi
echo "✅ mutation: 전 축 RED (게이트 검출력 확인)"
