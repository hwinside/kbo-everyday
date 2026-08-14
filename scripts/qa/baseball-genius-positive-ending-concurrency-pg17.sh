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

run_six() {
  local out="$1"; : > "$out"
  for id in 1 2 3 4 5 6; do
    "${PSQL[@]}" -c "select used_signature from public.claim_baseball_genius_positive_ending($id, '$USER_ID'::uuid, '도움이 됐다니 기쁩니다!')" >> "$out" &
  done
  wait
}

setup "$MIGRATION"
run_six "$WORK/baseline"
BASELINE="$(grep -c '^t$' "$WORK/baseline" || true)"
[[ "$BASELINE" == "1" ]] || { echo "FAIL baseline: expected exactly one signature, got $BASELINE"; exit 1; }

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
run_six "$WORK/mutated"
MUTATED="$(grep -c '^t$' "$WORK/mutated" || true)"
[[ "$MUTATED" != "1" ]] || { echo "FAIL mutation stayed GREEN: lock removal was not detected"; exit 1; }

echo "PASS genius positive ending concurrency: 6-way baseline signatures=$BASELINE, lock-removal mutation signatures=$MUTATED (RED)"
