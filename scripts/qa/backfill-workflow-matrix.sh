#!/bin/bash
# workflow validate step 의 fail-close matrix 회귀.
# yml 에서 Validate inputs 의 run 블록을 추출해 그대로 실행한다(로직 복제 금지).
set -uo pipefail
YML=".github/workflows/backfill-game-log-ledger.yml"
SCRIPT=$(python3 - <<'PY'
import re,yaml
d=yaml.safe_load(open(".github/workflows/backfill-game-log-ledger.yml"))
k=True if True in d else 'on'
for s in d['jobs']['backfill']['steps']:
    if s.get('name')=='Validate inputs':
        print(s['run'])
        break
PY
)
pass=0; fail=0
run_case() {
  local label="$1" expect="$2" season="$3" limit="$4" apply="$5" mode="$6"
  local out rc
  out=$(SEASON="$season" LIMIT="$limit" APPLY="$apply" MODE="$mode" \
        RELEASE_SEASON="2026" GITHUB_OUTPUT=/dev/null bash -c "$SCRIPT" 2>&1)
  rc=$?
  if [ "$expect" = "pass" ] && [ $rc -eq 0 ]; then
    echo "  ✓ $label (exit 0)"; pass=$((pass+1))
  elif [ "$expect" = "fail" ] && [ $rc -ne 0 ]; then
    echo "  ✓ $label (exit $rc) — $(echo "$out" | grep -o '::error::.*' | head -1)"; pass=$((pass+1))
  else
    echo "  ✗ $label expected=$expect got_exit=$rc"; echo "$out" | head -3; fail=$((fail+1))
  fi
}
echo "[workflow matrix] mode × limit × season fail-close"
run_case "RED canary+apply+limit0 (전체 apply 가 release 게이트 우회)" fail 2026 0 true canary
run_case "RED release+season2025 (고정 3경기와 불일치)"                fail 2025 0 true release
run_case "RED release+limit5 (3경기 미포함 가능)"                      fail 2026 5 true release
run_case "RED release+apply=false (공개 실행인데 쓰기 없음)"           fail 2026 0 false release
run_case "RED season 오타 (20266)"                                     fail 20266 0 false canary
run_case "RED limit 비정수 (abc)"                                      fail 2026 abc false canary
run_case "GREEN canary dry-run limit0"                                 pass 2026 0 false canary
run_case "GREEN canary apply limit5"                                   pass 2026 5 true canary
run_case "GREEN release apply season2026 limit0"                       pass 2026 0 true release
echo "결과: $pass pass / $fail fail"
[ $fail -eq 0 ] || exit 1
