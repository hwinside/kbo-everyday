#!/usr/bin/env bash
# claim_api_fallback_alert 멀티커넥션 동시성 회귀 (삼순 NO-GO: 실제 advisory-lock race).
#
# 임시 로컬 Postgres 17 클러스터를 띄워 20260729 migration 을 실제 적용한 뒤:
#   1) 서로 다른 커넥션 20개가 "동시에" 같은 api_name 으로 claim → should_send=true 정확히 1건
#      + attempt_token 도 정확히 1개(outbox 1행). 이벤트는 20건 durable.
#   2) confirm(현재 토큰) 전엔 alert_sent 0건, pending_event_id 유지.
#   3) 2xx confirm(토큰) 후 alert_sent 정확히 1건 + cooldown 확정으로 재claim false.
#   4) stale 토큰 confirm → no-op. anon/authenticated 는 테이블·RPC 접근 불가.
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
DATADIR="$WORK/data"; SOCKDIR="$WORK/sock"; mkdir -p "$SOCKDIR"
cleanup() { "$PGBIN/pg_ctl" -D "$DATADIR" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATADIR" -A trust -U qa --locale=C --encoding=UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATADIR" -o "-p 59323 -k $SOCKDIR -c listen_addresses=''" -w start >/dev/null
PSQL=("$PGBIN/psql" -h "$SOCKDIR" -p 59323 -U qa -d postgres -v ON_ERROR_STOP=1 -qtA)

"${PSQL[@]}" <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE TABLE public.api_fallback_events (
  id BIGSERIAL PRIMARY KEY, api_name TEXT NOT NULL, reason TEXT NOT NULL,
  status_code INT, error_message TEXT, timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  alert_sent BOOLEAN DEFAULT FALSE
);
CREATE INDEX idx_afe_composite ON public.api_fallback_events(api_name, timestamp DESC);
SQL
"${PSQL[@]}" -f "$MIGRATION" >/dev/null

pass=0 fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✅ $1"; else fail=$((fail+1)); echo "  ❌ $1 (got: $2 / want: $3)"; fi; }
API="kbo-scoreboard-linescore"

echo "[20 커넥션 동시 claim — should_send 정확히 1건]"
for i in $(seq 1 20); do
  "${PSQL[@]}" -c "SELECT should_send FROM public.claim_api_fallback_alert('$API','schema-error',null,'c$i',5,3,30,120)" > "$WORK/c$i" &
done
wait
TRUES=$(cat "$WORK"/c* | grep -c '^t$' || true)
EVENTS=$("${PSQL[@]}" -c "SELECT count(*) FROM public.api_fallback_events WHERE api_name='$API'")
STATEROWS=$("${PSQL[@]}" -c "SELECT count(*) FROM public.api_fallback_alert_state WHERE api_name='$API'")
PENDING=$("${PSQL[@]}" -c "SELECT count(*) FROM public.api_fallback_alert_state WHERE api_name='$API' AND pending_event_id IS NOT NULL AND attempt_token IS NOT NULL AND last_alerted_at IS NULL")
SENT=$("${PSQL[@]}" -c "SELECT count(*) FROM public.api_fallback_events WHERE api_name='$API' AND alert_sent=true")
check "동시 20 claim 중 should_send 정확히 1건" "$TRUES" "1"
check "이벤트 20건 durable 기록" "$EVENTS" "20"
check "alert_state 행 1개(api_name 별 1행 outbox)" "$STATEROWS" "1"
check "confirm 전: pending+token, last_alerted 없음" "$PENDING" "1"
check "confirm 전: alert_sent 마킹 0건" "$SENT" "0"

echo "[stale 토큰 confirm no-op + 현재 토큰 confirm]"
TOKEN=$("${PSQL[@]}" -c "SELECT attempt_token FROM public.api_fallback_alert_state WHERE api_name='$API'")
BADTOK="00000000-0000-0000-0000-000000000000"
R=$("${PSQL[@]}" -c "SELECT public.confirm_api_fallback_alert('$API','$BADTOK')")
check "stale 토큰 confirm → no-op(false)" "$R" "f"
SENT_AFTER_STALE=$("${PSQL[@]}" -c "SELECT count(*) FROM public.api_fallback_events WHERE api_name='$API' AND alert_sent=true")
check "stale confirm 후 sent 여전히 0건" "$SENT_AFTER_STALE" "0"
R=$("${PSQL[@]}" -c "SELECT public.confirm_api_fallback_alert('$API','$TOKEN')")
check "현재 토큰 confirm → true" "$R" "t"
SENT2=$("${PSQL[@]}" -c "SELECT count(*) FROM public.api_fallback_events WHERE api_name='$API' AND alert_sent=true")
check "confirm 후 alert_sent 정확히 1건" "$SENT2" "1"
R=$("${PSQL[@]}" -c "SELECT should_send FROM public.claim_api_fallback_alert('$API','schema-error',null,'again',5,3,30,120)")
check "cooldown 중 재claim → false" "$R" "f"

echo "[강제 interleaving — A confirm 락 보유 중 B drain 회전 차단(원자 fence)]"
# 삼순 3차 NO-GO: confirm SELECT→UPDATE 사이에 B 가 token 을 회전하면 stale A 가 event 를
# sent 로 마킹하고 true 반환하던 split-brain. 원자 fence(FOR UPDATE) 로 B 가 못 끓음을 증명.
API2="interleave-api"
for i in 1 2 3; do "${PSQL[@]}" -c "SELECT should_send FROM public.claim_api_fallback_alert('$API2','schema-error',null,'x$i',5,3,30,120)" >/dev/null; done
TOK_A=$("${PSQL[@]}" -c "SELECT attempt_token FROM public.api_fallback_alert_state WHERE api_name='$API2'")
EVID=$("${PSQL[@]}" -c "SELECT pending_event_id FROM public.api_fallback_alert_state WHERE api_name='$API2'")
# 행을 drain-적격(due)으로 만들어 B 가 column 상태로는 가져갈 수 있게 한뒤, A 의 FOR UPDATE 행잠금으로만 막힐다.
"${PSQL[@]}" -c "UPDATE public.api_fallback_alert_state SET locked_until=now()-interval '1 second', next_attempt_at=now()-interval '1 second' WHERE api_name='$API2'" >/dev/null
FIFO="$WORK/fifo_a"; mkfifo "$FIFO"
# 백그라운드 psql: FIFO 로 명령을 받아 A confirm 을 트랜잭션 안에서 실행 → COMMIT 까지 FOR UPDATE 락 보유.
"$PGBIN/psql" -h "$SOCKDIR" -p 59323 -U qa -d postgres -v ON_ERROR_STOP=1 -qtA < "$FIFO" > "$WORK/a_out" 2>&1 &
APID=$!
exec 3>"$FIFO"
echo "BEGIN;" >&3
echo "SELECT public.confirm_api_fallback_alert('$API2','$TOK_A') AS a_confirm;" >&3
sleep 1  # A 가 FOR UPDATE 락을 잡을 시간
BDRAIN=$("${PSQL[@]}" -c "SELECT count(*) FROM public.drain_api_fallback_alerts(120,120,20) WHERE api_name='$API2'")
echo "COMMIT;" >&3
exec 3>&-
wait "$APID" 2>/dev/null || true
ACONF=$(grep -Eo '^[tf]$' "$WORK/a_out" | head -1)
SENT_IL=$("${PSQL[@]}" -c "SELECT count(*) FROM public.api_fallback_events WHERE id=$EVID AND alert_sent=true")
PENDING_IL=$("${PSQL[@]}" -c "SELECT count(*) FROM public.api_fallback_alert_state WHERE api_name='$API2' AND pending_event_id IS NOT NULL")
check "A confirm 락 보유 중 B drain 회전 못 함(0건 skip)" "$BDRAIN" "0"
check "A confirm 성공(true)" "$ACONF" "t"
check "그 event 정확히 sent 마킹" "$SENT_IL" "1"
check "confirm 후 outbox 비워짐(split-brain 없음)" "$PENDING_IL" "0"

echo "[역 interleaving — B 가 먼저 token 회전 → 늦은 A confirm no-op]"
# A lease 만료 → B(drain) 가 새 token 으로 재획득 → 구 token 으로의 늦은 A confirm 은 no-op·B pending 유지.
API3="interleave-rev-api"
for i in 1 2 3; do "${PSQL[@]}" -c "SELECT should_send FROM public.claim_api_fallback_alert('$API3','schema-error',null,'y$i',5,3,30,120)" >/dev/null; done
TOK_A3=$("${PSQL[@]}" -c "SELECT attempt_token FROM public.api_fallback_alert_state WHERE api_name='$API3'")
EVID3=$("${PSQL[@]}" -c "SELECT pending_event_id FROM public.api_fallback_alert_state WHERE api_name='$API3'")
"${PSQL[@]}" -c "UPDATE public.api_fallback_alert_state SET locked_until=now()-interval '1 second', next_attempt_at=now()-interval '1 second' WHERE api_name='$API3'" >/dev/null
TOK_B3=$("${PSQL[@]}" -c "SELECT attempt_token FROM public.drain_api_fallback_alerts(120,120,20) WHERE api_name='$API3'")
check "B drain 이 새 token 으로 회전(구 token 과 다름)" "$([ -n "$TOK_B3" ] && [ "$TOK_B3" != "$TOK_A3" ] && echo t || echo f)" "t"
RA3=$("${PSQL[@]}" -c "SELECT public.confirm_api_fallback_alert('$API3','$TOK_A3')")
check "구 token 으로의 늦은 A confirm → no-op(false)" "$RA3" "f"
check "stale A confirm 후 그 event sent 미마킹" "$("${PSQL[@]}" -c "SELECT count(*) FROM public.api_fallback_events WHERE id=$EVID3 AND alert_sent=true")" "0"
check "stale A confirm 후 B outbox(pending+B token) 유지" "$("${PSQL[@]}" -c "SELECT count(*) FROM public.api_fallback_alert_state WHERE api_name='$API3' AND pending_event_id IS NOT NULL AND attempt_token='$TOK_B3' AND last_alerted_at IS NULL")" "1"

echo "[클라 롤 차단]"
check "anon 테이블 SELECT 불가" "$("${PSQL[@]}" -c "SELECT has_table_privilege('anon','public.api_fallback_alert_state','SELECT')")" "f"
check "authenticated 테이블 INSERT 불가" "$("${PSQL[@]}" -c "SELECT has_table_privilege('authenticated','public.api_fallback_alert_state','INSERT')")" "f"
check "anon claim RPC 실행 불가" "$("${PSQL[@]}" -c "SELECT has_function_privilege('anon','public.claim_api_fallback_alert(text,text,int,text,int,int,int,int)','EXECUTE')")" "f"
check "anon drain RPC 실행 불가" "$("${PSQL[@]}" -c "SELECT has_function_privilege('anon','public.drain_api_fallback_alerts(int,int,int)','EXECUTE')")" "f"
check "authenticated confirm RPC 실행 불가" "$("${PSQL[@]}" -c "SELECT has_function_privilege('authenticated','public.confirm_api_fallback_alert(text,uuid)','EXECUTE')")" "f"

echo ""
echo "결과: $pass pass / $fail fail"
[ "$fail" -eq 0 ]
