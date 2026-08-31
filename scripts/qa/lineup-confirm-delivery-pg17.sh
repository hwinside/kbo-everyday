#!/usr/bin/env bash
# 라인업 확정 원장 멀티커넥션 동시성 회귀 (삼순 #952: 실제 커넥션 race).
# 임시 PostgreSQL 17 클러스터에 20260729_lineup_confirm_notify 를 실제 적용한 뒤:
#   1) 동시 snapshot 10개 → single-flight: 원장 정확히 20행(10×20 아님) + state 1행.
#   2) 동시 claim 10개(limit 3) → skip-locked 분할: 각 행 정확히 1회 lease(총 leased 20, 이중 0).
#   3) mark→settle(accepted)→finalize → lineup_notified=true, accepted 20.
#   4) anon/authenticated RPC 실행 불가.
# 요구: PostgreSQL 17. 없으면 SKIP(exit 2).
set -euo pipefail
export LC_ALL=C LANG=C

PGBIN=""
for cand in "$(dirname "$(command -v initdb 2>/dev/null || true)")" /opt/homebrew/opt/postgresql@17/bin /usr/local/opt/postgresql@17/bin; do
  if [ -n "$cand" ] && [ -x "$cand/initdb" ] && [ -x "$cand/psql" ]; then PGBIN="$cand"; break; fi
done
if [ -z "$PGBIN" ]; then echo "SKIP: local PostgreSQL(initdb/psql) not found" >&2; exit 2; fi

MIGRATION="$(cd "$(dirname "$0")/../.." && pwd)/supabase/migrations/20260729_lineup_confirm_notify.sql"
MIGRATION_RETRY="$(cd "$(dirname "$0")/../.." && pwd)/supabase/migrations/20260731212000_lineup_notify_retry_outcome.sql"
[ -f "$MIGRATION" ] || { echo "migration not found: $MIGRATION" >&2; exit 1; }
[ -f "$MIGRATION_RETRY" ] || { echo "migration not found: $MIGRATION_RETRY" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/lineup-notify-qa.XXXXXX")"
DATADIR="$WORK/data"; SOCKDIR="$WORK/sock"; mkdir -p "$SOCKDIR"
cleanup() { "$PGBIN/pg_ctl" -D "$DATADIR" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATADIR" -A trust -U qa --locale=C --encoding=UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATADIR" -o "-p 59341 -k $SOCKDIR -c listen_addresses=''" -w start >/dev/null
PSQL=("$PGBIN/psql" -h "$SOCKDIR" -p 59341 -U qa -d postgres -v ON_ERROR_STOP=1 -qtA)

"${PSQL[@]}" <<'SQL'
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE TABLE profiles (id uuid primary key, team_id integer);
CREATE TABLE device_push_tokens (id bigserial primary key, user_id uuid not null, fcm_token text not null, platform text not null check (platform in ('ios','android')));
CREATE TABLE notification_prefs (user_id uuid primary key, lineup_confirm boolean, game_start boolean);
-- 팀1 팬 20명(전부 opt-in 기본).
INSERT INTO profiles(id, team_id) SELECT gen_random_uuid(), 1 FROM generate_series(1,20);
INSERT INTO device_push_tokens(user_id, fcm_token, platform) SELECT id, 'tok_'||id, 'ios' FROM profiles;
SQL
"${PSQL[@]}" -f "$MIGRATION" >/dev/null
"${PSQL[@]}" -f "$MIGRATION_RETRY" >/dev/null

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✅ $1"; else fail=$((fail+1)); echo "  ❌ $1 (got: $2 / want: $3)"; fi; }
G="20260729LGWO0"

echo "[동시 snapshot 10개 — single-flight]"
for i in $(seq 1 10); do
  "${PSQL[@]}" -c "SELECT snapshot_lineup_confirm_deliveries('$G',1, now(), now() + interval '30 minutes', 'LG 라인업 확정', '금일 라인업이 확정되었습니다.', '/games/$G?tab=lineup')" >/dev/null &
done
wait
LEDGER=$("${PSQL[@]}" -c "SELECT count(*) FROM lineup_confirm_delivery_ledger WHERE game_id='$G' AND team_id=1")
STATE=$("${PSQL[@]}" -c "SELECT count(*) FROM game_lineup_notify_state WHERE game_id='$G' AND team_id=1")
SNAP1=$("${PSQL[@]}" -c "SELECT count(*) FROM game_lineup_notify_state WHERE game_id='$G' AND team_id=1 AND lineup_snapshot_at IS NOT NULL AND lineup_notified=false")
check "동시 snapshot → 원장 정확히 20행(중복 0)" "$LEDGER" "20"
check "state 행 1개" "$STATE" "1"
check "snapshot 1회 고정(notified 전)" "$SNAP1" "1"
# (re-gate ③) list_due: 미완료 스냅샷을 payload 와 함께 반환.
DUE=$("${PSQL[@]}" -c "SELECT count(*) FROM list_due_lineup_confirm_snapshots(200) WHERE game_id='$G' AND team_id=1 AND push_title='LG 라인업 확정' AND push_url='/games/$G?tab=lineup'")
check "list_due → 미완료 스냅샷 1건(payload 포함)" "$DUE" "1"

echo "[동시 claim 10개(limit 3) — skip-locked 분할, 각 행 1회]"
for i in $(seq 1 10); do
  "${PSQL[@]}" -c "SELECT count(*) FROM claim_lineup_confirm_deliveries('$G',1, gen_random_uuid(),45,3)" > "$WORK/cl$i" &
done
wait
TOTAL=0; for i in $(seq 1 10); do TOTAL=$((TOTAL + $(cat "$WORK/cl$i" | tr -d '[:space:]'))); done
LEASED=$("${PSQL[@]}" -c "SELECT count(*) FROM lineup_confirm_delivery_ledger WHERE game_id='$G' AND team_id=1 AND status='leased'")
DISTINCT_LEASES=$("${PSQL[@]}" -c "SELECT count(DISTINCT lease_token) FROM lineup_confirm_delivery_ledger WHERE game_id='$G' AND team_id=1 AND status='leased'")
check "동시 claim 총합 20(각 행 정확히 1회)" "$TOTAL" "20"
check "leased 20행(이중 lease 0)" "$LEASED" "20"

echo "[mark→settle(accepted)→finalize]"
# 각 행을 자기 lease 로 mark→settle. 단순화: 전 행을 한 lease 로 재정렬(테스트 목적).
"${PSQL[@]}" -c "UPDATE lineup_confirm_delivery_ledger SET lease_token='00000000-0000-0000-0000-000000000001', status='leased' WHERE game_id='$G' AND team_id=1" >/dev/null
MARK=$("${PSQL[@]}" -c "SELECT mark_lineup_confirm_deliveries_dispatching(ARRAY(SELECT id FROM lineup_confirm_delivery_ledger WHERE game_id='$G' AND team_id=1),'00000000-0000-0000-0000-000000000001')")
check "mark dispatching 20" "$MARK" "20"
RES=$("${PSQL[@]}" -c "SELECT jsonb_agg(jsonb_build_object('id',id,'status','accepted')) FROM lineup_confirm_delivery_ledger WHERE game_id='$G' AND team_id=1")
ACC=$("${PSQL[@]}" -c "SELECT settle_lineup_confirm_delivery_batch('$RES'::jsonb,'00000000-0000-0000-0000-000000000001')")
check "settle accepted 20" "$ACC" "20"
NOTIFIED=$("${PSQL[@]}" -c "SELECT (snapshot_completed)::text FROM finalize_lineup_confirm_deliveries('$G',1)")
check "finalize snapshot_completed=true" "$NOTIFIED" "true"
LN=$("${PSQL[@]}" -c "SELECT (lineup_notified)::text FROM game_lineup_notify_state WHERE game_id='$G' AND team_id=1")
check "lineup_notified=true 전진" "$LN" "true"
# (re-gate ③) 종결된 스냅샷은 due 목록에서 제외(재drain 대상 아님).
DUE_AFTER=$("${PSQL[@]}" -c "SELECT count(*) FROM list_due_lineup_confirm_snapshots(200) WHERE game_id='$G' AND team_id=1")
check "종결 후 list_due 에서 제외" "$DUE_AFTER" "0"
SENTNULL=$("${PSQL[@]}" -c "SELECT count(*) FROM lineup_confirm_delivery_ledger WHERE game_id='$G' AND team_id=1 AND fcm_token IS NOT NULL")
check "accepted 뒤 fcm_token NULL(20행)" "$SENTNULL" "0"

echo "[클라 롤 차단]"
check "anon snapshot RPC 불가" "$("${PSQL[@]}" -c "SELECT has_function_privilege('anon','snapshot_lineup_confirm_deliveries(text,integer,timestamptz,timestamptz,text,text,text)','EXECUTE')")" "f"
check "authenticated claim RPC 불가" "$("${PSQL[@]}" -c "SELECT has_function_privilege('authenticated','claim_lineup_confirm_deliveries(text,integer,uuid,integer,integer)','EXECUTE')")" "f"
check "anon list_due RPC 불가" "$("${PSQL[@]}" -c "SELECT has_function_privilege('anon','list_due_lineup_confirm_snapshots(integer)','EXECUTE')")" "f"
check "anon 원장 SELECT 불가" "$("${PSQL[@]}" -c "SELECT has_table_privilege('anon','lineup_confirm_delivery_ledger','SELECT')")" "f"

echo ""
echo "결과: $pass pass / $fail fail"
[ "$fail" -eq 0 ]
