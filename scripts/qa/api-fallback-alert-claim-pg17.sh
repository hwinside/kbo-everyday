#!/usr/bin/env bash
# claim_api_fallback_alert 멀티커넥션 동시성 회귀 (삼순 2차 NO-GO blocker 4).
#
# 임시 로컬 Postgres 17 클러스터를 띄워 20260729 migration 을 실제 적용한 뒤:
#   1) 서로 다른 커넥션 20개가 "동시에" 같은 api_name 으로 claim → should_send=true 정확히 1건
#      (advisory xact lock 직렬화 + upsert-where cooldown/lease claim). 이벤트는 20건 durable.
#   2) confirm 전엔 alert_state 에 pending_lease 만, alert_sent 마킹 0건.
#   3) 2xx confirm 후 alert_sent 정확히 1건 + cooldown 확정으로 재claim 차단.
#   4) anon/authenticated 는 테이블 직접 접근·RPC 실행 불가.
# PGlite 순차 테스트가 못 잡는 실제 커넥션 race 를 커밋된 회귀로 고정한다.
#
# 요구: PostgreSQL 17 (PATH 또는 /opt/homebrew/opt/postgresql@17/bin). 없으면 SKIP(exit 2).
set -euo pipefail
export LC_ALL=C LANG=C

PGBIN=""
for cand in "$(dirname "$(command -v initdb 2>/dev/null || true)")" /opt/homebrew/opt/postgresql@17/bin /usr/local/opt/postgresql@17/bin; do
  if [ -n "$cand" ] && [ -x "$cand/initdb" ] && [ -x "$cand/psql" ]; then PGBIN="$cand"; break; fi
done
if [ -z "$PGBIN" ]; then
  echo "SKIP: local PostgreSQL(initdb/psql) not found" >&2
  exit 2
fi

MIGRATION="$(cd "$(dirname "$0")/../.." && pwd)/supabase/migrations/20260729_api_fallback_alert_claim.sql"
[ -f "$MIGRATION" ] || { echo "migration not found: $MIGRATION" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/afe-alert-qa.XXXXXX")"
DATADIR="$WORK/data"
SOCKDIR="$WORK/sock"
mkdir -p "$SOCKDIR"
cleanup() {
  "$PGBIN/pg_ctl" -D "$DATADIR" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATADIR" -A trust -U qa --locale=C --encoding=UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATADIR" -o "-p 59323 -k $SOCKDIR -c listen_addresses=''" -w start >/dev/null

PSQL=("$PGBIN/psql" -h "$SOCKDIR" -p 59323 -U qa -d postgres -v ON_ERROR_STOP=1 -qtA)

# 롤 + api_fallback_events 최소 스키마 후 migration 적용.
"${PSQL[@]}" <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE TABLE public.api_fallback_events (
  id BIGSERIAL PRIMARY KEY,
  api_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  status_code INT,
  error_message TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  alert_sent BOOLEAN DEFAULT FALSE
);
CREATE INDEX idx_afe_composite ON public.api_fallback_events(api_name, timestamp DESC);
SQL
"${PSQL[@]}" -f "$MIGRATION" >/dev/null

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✅ $1"; else fail=$((fail+1)); echo "  ❌ $1 (got: $2 / want: $3)"; fi; }

API="kbo-scoreboard-linescore"

echo "[20 커넥션 동시 claim — should_send 정확히 1건]"
for i in $(seq 1 20); do
  "${PSQL[@]}" -c "SELECT public.claim_api_fallback_alert('$API','schema-error',null,'c$i',5,3,30,120)" > "$WORK/c$i" &
done
wait
TRUES=$(cat "$WORK"/c* | grep -c '^t$' || true)
EVENTS=$("${PSQL[@]}" -c "SELECT count(*) FROM public.api_fallback_events WHERE api_name='$API'")
STATEROWS=$("${PSQL[@]}" -c "SELECT count(*) FROM public.api_fallback_alert_state WHERE api_name='$API'")
PENDING=$("${PSQL[@]}" -c "SELECT count(*) FROM public.api_fallback_alert_state WHERE api_name='$API' AND pending_lease_at IS NOT NULL AND last_alerted_at IS NULL")
SENT=$("${PSQL[@]}" -c "SELECT count(*) FROM public.api_fallback_events WHERE api_name='$API' AND alert_sent=true")
check "동시 20 claim 중 should_send 정확히 1건" "$TRUES" "1"
check "이벤트 20건 durable 기록" "$EVENTS" "20"
check "alert_state 행 1개(api_name 별 1행)" "$STATEROWS" "1"
check "confirm 전: pending_lease 만, last_alerted 없음" "$PENDING" "1"
check "confirm 전: alert_sent 마킹 0건" "$SENT" "0"

echo "[2xx confirm 후: cooldown 확정 + 마킹 1건 + 재claim 차단]"
"${PSQL[@]}" -c "SELECT public.confirm_api_fallback_alert('$API')" >/dev/null
SENT2=$("${PSQL[@]}" -c "SELECT count(*) FROM public.api_fallback_events WHERE api_name='$API' AND alert_sent=true")
check "confirm 후 alert_sent 정확히 1건" "$SENT2" "1"
R=$("${PSQL[@]}" -c "SELECT public.claim_api_fallback_alert('$API','schema-error',null,'again',5,3,30,120)")
check "cooldown 중 재claim → false" "$R" "f"

echo "[클라 롤 차단]"
check "anon 테이블 SELECT 불가" "$("${PSQL[@]}" -c "SELECT has_table_privilege('anon','public.api_fallback_alert_state','SELECT')")" "f"
check "authenticated 테이블 INSERT 불가" "$("${PSQL[@]}" -c "SELECT has_table_privilege('authenticated','public.api_fallback_alert_state','INSERT')")" "f"
check "anon claim RPC 실행 불가" "$("${PSQL[@]}" -c "SELECT has_function_privilege('anon','public.claim_api_fallback_alert(text,text,int,text,int,int,int,int)','EXECUTE')")" "f"
check "authenticated confirm RPC 실행 불가" "$("${PSQL[@]}" -c "SELECT has_function_privilege('authenticated','public.confirm_api_fallback_alert(text)','EXECUTE')")" "f"

echo ""
echo "결과: $pass pass / $fail fail"
[ "$fail" -eq 0 ]
