#!/bin/bash
# `Verify apply made progress` 의 complete 파싱 회귀.
#
# 사고: run 30679031813 (canary limit=5 apply=true) 은 백필이 5경기 전부 성공했는데
#       apply 가드가 `apply run produced no complete ledger rows` 로 실패했다.
#
#   로그:   대상 5 | complete 5 | incomplete 0
#   파서:   grep -oE 'complete [0-9]+' | tail -1
#   매치:   "complete 5" 와 "complete 0"  ← "in|complete 0| " 의 뒷부분
#   tail -1 → "complete 0" → COMPLETE=0
#
# 개수가 안 늘면(재실행·덮어쓰기) `after == before && complete == 0` 이 성립해
# 멀쩡한 성공이 실패가 된다. 반대로 개수가 늘면 파서가 틀려도 그냥 통과해서
# (run 30679124695: before=15 after=20 complete=0 인데 success) 오랫동안 안 드러난다.
#
# 수정: 스크립트가 고정 형식 `[ledger-backfill] RESULT target=N complete=N incomplete=N`
#       한 줄을 내보내고, 워크플로는 그 줄만 읽는다.
#
# 로직을 복제하지 않고 yml 에서 해당 step 의 run 블록을 그대로 추출해 실행한다.
set -uo pipefail
cd "$(dirname "$0")/../.."

SCRIPT=$(node -e '
const fs = require("fs");
const yaml = require("js-yaml");
const doc = yaml.load(fs.readFileSync(".github/workflows/backfill-game-log-ledger.yml", "utf8"));
const step = doc.jobs.backfill.steps.find((s) => s.name === "Verify apply made progress");
if (!step) { console.error("Verify apply made progress step not found"); process.exit(1); }
process.stdout.write(step.run);
')
if [ -z "$SCRIPT" ]; then
  echo "✗ failed to extract Verify apply made progress run block"
  exit 1
fi

PASS=0
FAIL=0
ok()  { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

# GitHub 표현식을 인자로 치환해 실행한다.
run_guard() {
  local before="$1" after="$2" log="$3"
  local s
  s=${SCRIPT//\$\{\{ steps.before.outputs.count \}\}/$before}
  s=${s//\$\{\{ steps.after.outputs.count \}\}/$after}
  if printf '%s' "$s" | grep -q '\${{'; then
    echo "unsubstituted expression" >&2
    return 99
  fi
  printf '%s\n' "$log" > /tmp/backfill.log
  bash -e -c "$s" 2>&1
}

expect() {
  local label="$1" want="$2" before="$3" after="$4" log="$5"
  local out rc
  out=$(run_guard "$before" "$after" "$log")
  rc=$?
  if [ "$want" = "pass" ] && [ $rc -eq 0 ]; then
    ok "$label (exit 0) — $(printf '%s' "$out" | grep -o 'complete=[0-9]*' | tail -1)"
  elif [ "$want" = "fail" ] && [ $rc -ne 0 ]; then
    ok "$label (exit $rc)"
  else
    bad "$label expected=$want got_exit=$rc"
    printf '%s\n' "$out" | head -4
  fi
}

# 실제 스크립트가 내보내는 형식 그대로.
summary() {
  printf '[ledger-backfill] === 요약 ===\n대상 %s | complete %s | incomplete %s\n[ledger-backfill] RESULT target=%s complete=%s incomplete=%s\n' \
    "$1" "$2" "$3" "$1" "$2" "$3"
}

echo "[ledger complete parse] apply 가드 파싱 계약"

# ── 사고 재현 케이스 ────────────────────────────────────────────────────────
# 개수 불변(덮어쓰기) + 전부 성공. 구 파서는 complete=0 으로 읽어 실패시켰다.
expect "RED  run 30679031813 재현 — 5/5 성공·개수 불변이면 통과해야 한다" \
       pass 15 15 "$(summary 5 5 0)"

# 개수 불변 + 실제로 아무것도 complete 안 됨 → 진짜 무진행이므로 실패해야 한다.
expect "GREEN 개수 불변 + complete 0 (진짜 무진행) → 실패" \
       fail 15 15 "$(summary 5 0 5)"

# 개수 증가 + 전부 성공 → 통과
expect "GREEN 개수 증가 + complete 20 → 통과" \
       pass 15 20 "$(summary 20 20 0)"

# 개수 감소 → 무조건 실패(기존 계약 유지)
expect "GREEN 개수 감소 → 실패" \
       fail 20 15 "$(summary 5 5 0)"

# RESULT 행이 없으면 fail-close. 구 구현은 `|| echo 0` 으로 조용히 0 이 됐고,
# after>before 면 그대로 통과해 파싱 실패가 드러나지 않았다.
expect "RED  RESULT 행 없음 → fail-close (구 구현은 조용히 0 후 통과)" \
       fail 15 20 "$(printf '[ledger-backfill] === 요약 ===\n대상 5 | complete 5 | incomplete 0\n')"

expect "RED  RESULT 중복 → 마지막 행 임의 채택 금지" \
       fail 15 15 "$(summary 5 0 5)$(summary 5 5 0)"
expect "RED  필드 누락 → fail-close" \
       fail 15 15 "[ledger-backfill] RESULT complete=5"
expect "RED  필드 순서 변경 → fail-close" \
       fail 15 15 "[ledger-backfill] RESULT complete=5 target=5 incomplete=0"
expect "RED  suffix 오염 → fail-close" \
       fail 15 15 "[ledger-backfill] RESULT target=5 complete=5 incomplete=0 garbage=1"
expect "RED  target 합계 불일치 → fail-close" \
       fail 15 15 "[ledger-backfill] RESULT target=5 complete=5 incomplete=5"

# 숫자가 아닌 count 는 기존대로 차단
expect "GREEN count 비숫자 → 실패" \
       fail "" 20 "$(summary 5 5 0)"

# ── 하니스 자체 검증 ────────────────────────────────────────────────────────
# 구 파서를 그대로 재현해 사고 케이스에서 실제로 0 이 나오는지 확인한다.
# 이게 0 이 아니면 위 RED 는 아무것도 증명하지 못한다.
summary 5 5 0 > /tmp/backfill.log
LEGACY=$(grep -oE 'complete [0-9]+' /tmp/backfill.log | tail -1 | grep -oE '[0-9]+' || echo "0")
if [ "$LEGACY" = "0" ]; then
  ok "하니스 자체 검증: 구 파서는 '대상 5 | complete 5 | incomplete 0' 에서 실제로 0 산출"
else
  bad "하니스 자체 검증 실패: 구 파서가 $LEGACY 를 산출 — 사고 재현이 안 됨"
fi

# 신 파서가 같은 입력에서 5 를 읽는지 직접 확인
if printf '%s' "$SCRIPT" | grep -Fq 'RESULT totals disagree' && \
   printf '%s' "$SCRIPT" | grep -Fq 'must have exactly one RESULT line' && \
   printf '%s' "$SCRIPT" | grep -Fq 'incomplete=([0-9]+)$'; then
  ok "strict guard mutation lock: 유일행·전체 anchored parse·합계 검증이 step에 결속"
else
  bad "strict guard mutation lock 누락"
fi

rm -f /tmp/backfill.log
echo ""
echo "[ledger complete parse] PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ] || exit 1
