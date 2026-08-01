#!/bin/bash
# `Run backfill` step 의 실패 전파 회귀.
#
# 사고: run 30655482859 은 backfill 이 SyntaxError 로 죽었는데 job/run 이 SUCCESS 였다.
#   npx tsx ... 2>&1 | tee /tmp/backfill.log
# 파이프라인의 종료코드는 마지막 명령(tee, 항상 0)의 것이라, pipefail 이 없으면
# 앞 명령의 실패가 통째로 삼켜진다. 실패한 백필을 성공으로 오인하면 그대로
# 공개 단계로 넘어간다 — 그래서 P0 다.
#
# 로직을 복제하지 않고 yml 에서 해당 step 의 run 블록을 그대로 추출해 실행한다
# (backfill-workflow-matrix.sh 와 동일한 방식). GitHub 표현식만 치환하고,
# npx 를 stub 으로 가려 실제 네트워크/DB 없이 종료코드만 관찰한다.
set -uo pipefail
cd "$(dirname "$0")/../.."

SCRIPT=$(node -e '
const fs = require("fs");
const yaml = require("js-yaml");
const doc = yaml.load(fs.readFileSync(".github/workflows/backfill-game-log-ledger.yml", "utf8"));
const step = doc.jobs.backfill.steps.find((s) => s.name === "Run backfill");
if (!step) { console.error("Run backfill step not found"); process.exit(1); }
process.stdout.write(step.run);
')
if [ -z "$SCRIPT" ]; then
  echo "✗ failed to extract Run backfill run block"
  exit 1
fi

# GitHub 표현식은 러너가 치환한다 — 로컬 실행을 위해 동일 형태로 대체.
SCRIPT=${SCRIPT//\$\{\{ steps.validate.outputs.season \}\}/2026}
SCRIPT=${SCRIPT//\$\{\{ steps.validate.outputs.limit \}\}/5}
SCRIPT=${SCRIPT//\$\{\{ steps.validate.outputs.apply \}\}/false}

if printf '%s' "$SCRIPT" | grep -q '\${{'; then
  echo "✗ unsubstituted GitHub expression remains — update this harness"
  printf '%s\n' "$SCRIPT" | grep '\${{'
  exit 1
fi

pass=0
fail=0

# stub 디렉터리를 PATH 앞에 둬 `npx` 를 가로챈다. 실제 tsx/DB 는 타지 않는다.
make_stub() {
  local exit_code="$1"
  local dir
  dir=$(mktemp -d)
  cat > "$dir/npx" <<EOF
#!/bin/bash
echo "[stub npx] \$*"
echo "[stub npx] simulated exit $exit_code"
exit $exit_code
EOF
  chmod +x "$dir/npx"
  echo "$dir"
}

run_case() {
  local label="$1" stub_exit="$2" expect="$3"
  local dir out rc log
  dir=$(make_stub "$stub_exit")
  log=$(mktemp)
  # GitHub 의 기본 셸은 `bash -e {0}` 다. 동일 조건으로 실행해야 의미가 있다.
  out=$(PATH="$dir:$PATH" bash -e -c "$SCRIPT" 2>&1)
  rc=$?
  rm -rf "$dir" "$log"
  if [ "$expect" = "fail" ] && [ "$rc" -ne 0 ]; then
    echo "  ✓ $label (exit $rc — 실패가 전파됨)"; pass=$((pass+1))
  elif [ "$expect" = "pass" ] && [ "$rc" -eq 0 ]; then
    echo "  ✓ $label (exit 0)"; pass=$((pass+1))
  else
    echo "  ✗ $label expected=$expect got_exit=$rc"
    printf '%s\n' "$out" | head -5
    fail=$((fail+1))
  fi
}

echo "[backfill failfast] Run backfill step 실패 전파"
run_case "RED  backfill 이 1로 죽으면 step 도 실패해야 한다 (tee 가 삼키면 여기서 걸린다)" 1 fail
run_case "RED  backfill SyntaxError 상당(exit 1) — run 30655482859 재현"                    1 fail
run_case "RED  backfill 이 다른 코드(2)로 죽어도 실패"                                       2 fail
run_case "GREEN backfill 성공이면 step 도 성공"                                              0 pass

# 회귀 가드: pipefail 을 지우면 위 RED 가 통과해버린다 — 그 자체를 직접 확인한다.
NO_PIPEFAIL=${SCRIPT//set -euo pipefail/set -eu}
if [ "$NO_PIPEFAIL" = "$SCRIPT" ]; then
  echo "  ✗ run 블록에 'set -euo pipefail' 이 없다 — 실패가 tee 로 삼켜진다"
  fail=$((fail+1))
else
  dir=$(make_stub 1)
  PATH="$dir:$PATH" bash -e -c "$NO_PIPEFAIL" >/dev/null 2>&1
  rc=$?
  rm -rf "$dir"
  if [ "$rc" -eq 0 ]; then
    echo "  ✓ 하니스 자체 검증: pipefail 제거 시 실패가 실제로 삼켜짐(exit 0) — 이 테스트가 유효함"
    pass=$((pass+1))
  else
    echo "  ✗ 하니스 자체 검증 실패: pipefail 없이도 exit $rc — 테스트가 무의미할 수 있다"
    fail=$((fail+1))
  fi
fi

echo "결과: $pass pass / $fail fail"
[ $fail -eq 0 ] || exit 1
