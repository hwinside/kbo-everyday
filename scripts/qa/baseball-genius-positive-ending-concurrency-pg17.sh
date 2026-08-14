#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C LANG=C

for cand in "$(dirname "$(command -v initdb 2>/dev/null || true)")" /opt/homebrew/opt/postgresql@17/bin /usr/local/opt/postgresql@17/bin; do
  if [[ -x "$cand/initdb" && -x "$cand/postgres" && -x "$cand/psql" ]]; then PGBIN="$cand"; break; fi
done
[[ -n "${PGBIN:-}" ]] || { echo "FAIL: postgresql@17 binaries not found"; exit 1; }

WORK="$(mktemp -d "/tmp/genius-positive-ending.XXXXXX")"
trap '"$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT
PORT=$((59400 + RANDOM % 100))
"$PGBIN/initdb" -D "$WORK/data" -A trust -U postgres --locale=C --encoding=UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$WORK/data" -l "$WORK/postgres.log" -o "-k $WORK -p $PORT -c fsync=off -c full_page_writes=off" -w start >/dev/null
PSQL=("$PGBIN/psql" -h "$WORK" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA)
SERVER_VERSION_NUM="$("${PSQL[@]}" -c "show server_version_num")"
[[ "$SERVER_VERSION_NUM" =~ ^17[0-9]{4}$ ]] || { echo "FAIL: expected PostgreSQL 17 server, got server_version_num=$SERVER_VERSION_NUM"; exit 1; }
MIGRATION="supabase/migrations/20260814154000_baseball_genius_positive_ending_ledger.sql"
USER_ID="00000000-0000-4000-8000-000000001186"

setup() {
  "${PSQL[@]}" <<SQL >/dev/null
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
DO \$\$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;
DO \$\$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;
DO \$\$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;
CREATE TABLE public.dm_messages(id bigint PRIMARY KEY);
INSERT INTO public.dm_messages(id) SELECT generate_series(1, 6);
SQL
  "${PSQL[@]}" -f "$1" >/dev/null
}

# PID별 wait: 인자 없는 wait는 자식 실패를 버리고 0을 반환한다(거짓 PASS).
# 각 자식 exit code를 개별 검증하고, 유효 결과 행(t/f)이 정확히 6개인지도 확인한다.
run_six() {
  local out="$1" inject="${2:-}"
  : > "$out"
  local pids=() id sql
  for id in 1 2 3 4 5 6; do
    sql="select used_signature from public.claim_baseball_genius_positive_ending($id, '$USER_ID'::uuid, '도움이 됐다니 기쁩니다!')"
    if [[ "$inject" == "child-failure" && "$id" == "6" ]]; then
      sql="select public.no_such_function_1186()"
    fi
    "${PSQL[@]}" -c "$sql" >> "$out" &
    pids+=("$!")
  done
  local failed=0 pid
  for pid in "${pids[@]}"; do
    wait "$pid" || failed=$((failed + 1))
  done
  [[ "$failed" == "0" ]] || { echo "run_six: $failed child psql invocation(s) failed"; return 1; }
  local valid
  valid="$(grep -Ec '^[tf]$' "$out" || true)"
  [[ "$valid" == "6" ]] || { echo "run_six: expected exactly 6 valid result rows, got $valid"; return 1; }
  return 0
}

setup "$MIGRATION"
run_six "$WORK/baseline" || { echo "FAIL baseline: child failure or invalid result rows"; exit 1; }
BASELINE="$(grep -c '^t$' "$WORK/baseline" || true)"
[[ "$BASELINE" == "1" ]] || { echo "FAIL baseline: expected exactly one signature, got $BASELINE"; exit 1; }

# Selftest: 자식 실패를 하네스가 반드시 검출해야 한다(검출 실패 = 게이트 자체 결함).
setup "$MIGRATION"
if run_six "$WORK/selftest" child-failure >/dev/null; then
  echo "FAIL selftest: injected child failure was NOT detected (harness would false-PASS)"; exit 1
fi
echo "selftest: injected child failure detected (harness fail-closed)"

# Mutation: user lock 제거 + 판정과 INSERT 사이 race window를 열면 게이트가 반드시 RED여야 한다.
awk '
  /^  PERFORM pg_advisory_xact_lock\(hashtextextended\(p_user_id::text, 1186\)\);$/ {
    print "  -- MUTATION: per-user lock removed"; lock += 1; next
  }
  { print }
  /^  \) INTO v_used_recently;$/ { print "  PERFORM pg_sleep(0.35);"; sleep += 1 }
  END { if (lock != 1 || sleep != 1) exit 42 }
' "$MIGRATION" > "$WORK/mutated.sql" || { echo "FAIL: mutation anchors drifted"; exit 1; }
setup "$WORK/mutated.sql"
run_six "$WORK/mutated" || { echo "FAIL mutation run: child failure or invalid result rows"; exit 1; }
MUTATED="$(grep -c '^t$' "$WORK/mutated" || true)"
[[ "$MUTATED" != "1" ]] || { echo "FAIL mutation stayed GREEN: lock removal was not detected"; exit 1; }

echo "PASS genius positive ending concurrency: 6-way baseline signatures=$BASELINE, lock-removal mutation signatures=$MUTATED (RED)"
