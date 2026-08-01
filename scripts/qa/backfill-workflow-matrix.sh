#!/bin/bash
# backfill 워크플로 `Validate inputs` 의 fail-close matrix 회귀.
#
# 로직을 복제하지 않고 yml 에서 해당 step 의 run 블록을 그대로 추출해 실행한다.
# parser 는 repo devDependency 인 js-yaml (node) — 러너에 선언되지 않은 python yaml 에
# 의존하지 않는다(삼순 P1).
set -uo pipefail
cd "$(dirname "$0")/../.."

SCRIPT=$(node -e '
const fs = require("fs");
const yaml = require("js-yaml");
const doc = yaml.load(fs.readFileSync(".github/workflows/backfill-game-log-ledger.yml", "utf8"));
const step = doc.jobs.backfill.steps.find((s) => s.name === "Validate inputs");
if (!step) { console.error("Validate inputs step not found"); process.exit(1); }
process.stdout.write(step.run);
')
if [ -z "$SCRIPT" ]; then
  echo "✗ failed to extract Validate inputs run block"
  exit 1
fi

pass=0
fail=0
run_case() {
  local label="$1" expect="$2" season="$3" limit="$4" apply="$5" mode="$6"
  local out rc
  out=$(SEASON="$season" LIMIT="$limit" APPLY="$apply" MODE="$mode" \
        RELEASE_SEASON="2026" CANARY_MAX_LIMIT="50" GITHUB_OUTPUT=/dev/null bash -c "$SCRIPT" 2>&1)
  rc=$?
  if [ "$expect" = "pass" ] && [ $rc -eq 0 ]; then
    echo "  ✓ $label (exit 0)"; pass=$((pass+1))
  elif [ "$expect" = "fail" ] && [ $rc -ne 0 ]; then
    echo "  ✓ $label (exit $rc) — $(echo "$out" | grep -o '::error::.*' | head -1)"; pass=$((pass+1))
  else
    echo "  ✗ $label expected=$expect got_exit=$rc"; echo "$out" | head -3; fail=$((fail+1))
  fi
}

echo "[workflow matrix] mode × apply × limit × season fail-close"
# whitelist — 오타값이 어느 분기에도 안 걸려 전체 apply + release gate skip 되는 경로
run_case "RED mode 오타 (typo) — 전체 apply + release gate 동시 우회" fail 2026 0 true typo
run_case "RED mode 빈값"                                              fail 2026 0 true ""
run_case "RED mode 대문자 (RELEASE)"                                  fail 2026 0 true RELEASE
run_case "RED apply 오타 (yes)"                                       fail 2026 5 yes canary
# mode × limit × season 결속
run_case "RED canary+apply+limit0 (전체 apply 가 release 게이트 우회)" fail 2026 0 true canary
run_case "RED release+season2025 (고정 3경기와 불일치)"                fail 2025 0 true release
run_case "RED release+limit5 (3경기 미포함 가능)"                      fail 2026 5 true release
run_case "RED release+apply=false (공개 실행인데 쓰기 없음)"           fail 2026 0 false release
# 형식 검증
run_case "RED canary+apply+limit=00 (Number 0 → 전체 apply)"           fail 2026 00 true canary
run_case "RED canary+apply+limit=000"                                 fail 2026 000 true canary
run_case "RED canary+apply+limit=999999 (slice 가 전체 선택)"          fail 2026 999999 true canary
run_case "RED canary+apply+limit=51 (상한 초과)"                       fail 2026 51 true canary
run_case "GREEN canary apply limit50 (상한 경계)"                      pass 2026 50 true canary
run_case "RED season 오타 (20266)"                                     fail 20266 0 false canary
run_case "RED limit 비정수 (abc)"                                      fail 2026 abc false canary
# 정상 경로
run_case "GREEN canary dry-run limit0"                                 pass 2026 0 false canary
run_case "GREEN canary apply limit5"                                   pass 2026 5 true canary
run_case "GREEN release apply season2026 limit0"                       pass 2026 0 true release

echo "결과: $pass pass / $fail fail"
[ $fail -eq 0 ] || exit 1
