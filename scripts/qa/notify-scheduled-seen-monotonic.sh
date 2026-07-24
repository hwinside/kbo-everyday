#!/usr/bin/env bash
# mark_scheduled_seen RPC 원자 단조 저장 통합 회귀 (삼순 #815 재리뷰 blocker)
#
# 임시 로컬 Postgres 클러스터를 띄워 migration 의 RPC 를 실제로 적용한 뒤:
#   1) 역순 저장: t60 저장 → 뒤늦은 t0(과거) 저장 → last_seen = t60 유지 (GREATEST 단조)
#   2) 최신 방향 전진: t60 → t120 → last_seen = t120 (단조 갱신)
#   3) 최초 관측(기존 NULL)은 그대로 기록 (GREATEST 가 NULL 무시)
#   4) 다건 배열 upsert (unnest) — 여러 game_id 동시 저장
#   5) 겹친 write 원자성: 같은 game_id 로 t0/t60 "동시" 호출 후 항상 t60 (락 직렬화)
#   6) 클라 롤(anon/authenticated) EXECUTE 차단, service_role 만 허용
# 를 검증한다. supabase local 없이도 도는 순수 pg 통합 테스트.
#
# 요구: PostgreSQL 17 (PATH 또는 /opt/homebrew/opt/postgresql@17/bin)
set -euo pipefail

# macOS + 한국어 로케일에서 postmaster 가 멀티쓰레드로 물들어 기동 실패하는 문제 회피
export LC_ALL=C LANG=C

PGBIN=""
for cand in "$(dirname "$(command -v initdb 2>/dev/null || true)")" /opt/homebrew/opt/postgresql@17/bin /usr/local/opt/postgresql@17/bin; do
  if [ -n "$cand" ] && [ -x "$cand/initdb" ] && [ -x "$cand/psql" ]; then PGBIN="$cand"; break; fi
done
if [ -z "$PGBIN" ]; then
  echo "SKIP: local PostgreSQL(initdb/psql) not found" >&2
  exit 2
fi

MIGRATION="$(cd "$(dirname "$0")/../.." && pwd)/supabase/migrations/20260724_notify_scheduled_seen_monotonic.sql"
[ -f "$MIGRATION" ] || { echo "migration not found: $MIGRATION" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/notify-seen-qa.XXXXXX")"
DATADIR="$WORK/data"
SOCKDIR="$WORK/sock"
mkdir -p "$SOCKDIR"
cleanup() {
  "$PGBIN/pg_ctl" -D "$DATADIR" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATADIR" -A trust -U qa --locale=C --encoding=UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATADIR" -o "-p 59322 -k $SOCKDIR -c listen_addresses=''" -w start >/dev/null

PSQL=("$PGBIN/psql" -h "$SOCKDIR" -p 59322 -U qa -d postgres -v ON_ERROR_STOP=1 -qtA)

# 의존 스텁: game_notify_state (RPC 가 참조하는 최소 스키마) + 클라 롤.
# 프로덕션 스키마와 동일하게 game_id PK + last_seen_scheduled_at timestamptz.
"${PSQL[@]}" <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE TABLE game_notify_state (
  game_id TEXT PRIMARY KEY,
  start_notified BOOLEAN NOT NULL DEFAULT false,
  end_notified BOOLEAN NOT NULL DEFAULT false,
  last_seen_scheduled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);
SQL

"${PSQL[@]}" -f "$MIGRATION" >/dev/null

# 고정 관측시각 3점 (t0 < t60 < t120)
T0='2026-07-24T18:30:00Z'
T60='2026-07-24T18:31:00Z'
T120='2026-07-24T18:32:00Z'

pass=0; fail=0
check() { # name actual expected
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✅ $1"
  else fail=$((fail+1)); echo "  ❌ $1 (got: $2 / want: $3)"; fi
}
seen() { # game_id -> last_seen_scheduled_at as epoch (정수, 비교 안정화)
  "${PSQL[@]}" -c "SELECT COALESCE(extract(epoch FROM last_seen_scheduled_at)::bigint::text,'NULL') FROM game_notify_state WHERE game_id='$1'"
}
EP_T0=$("${PSQL[@]}" -c "SELECT extract(epoch FROM timestamptz '$T0')::bigint")
EP_T60=$("${PSQL[@]}" -c "SELECT extract(epoch FROM timestamptz '$T60')::bigint")
EP_T120=$("${PSQL[@]}" -c "SELECT extract(epoch FROM timestamptz '$T120')::bigint")

echo "[역순 저장 — 뒤늦은 과거 관측이 최신값을 덮지 않음 (핵심 blocker)]"
G=20260724HHLG0
"${PSQL[@]}" -c "SELECT mark_scheduled_seen(ARRAY['$G'], timestamptz '$T60')" >/dev/null
check "t60 최초 저장" "$(seen $G)" "$EP_T60"
"${PSQL[@]}" -c "SELECT mark_scheduled_seen(ARRAY['$G'], timestamptz '$T0')" >/dev/null
check "뒤늦은 t0 저장 후에도 last_seen = t60 유지 (GREATEST 단조)" "$(seen $G)" "$EP_T60"

echo "[최신 방향 전진 — 단조 갱신]"
"${PSQL[@]}" -c "SELECT mark_scheduled_seen(ARRAY['$G'], timestamptz '$T120')" >/dev/null
check "t120 저장 → last_seen 전진" "$(seen $G)" "$EP_T120"
"${PSQL[@]}" -c "SELECT mark_scheduled_seen(ARRAY['$G'], timestamptz '$T60')" >/dev/null
check "다시 과거 t60 저장해도 t120 유지" "$(seen $G)" "$EP_T120"

echo "[최초 관측 — 기존 NULL 은 GREATEST 무시로 그대로 기록]"
G2=20260724SSKI0
check "저장 전 행 부재(선점 없음)" "$(seen $G2)" ""
"${PSQL[@]}" -c "SELECT mark_scheduled_seen(ARRAY['$G2'], timestamptz '$T0')" >/dev/null
check "NULL → t0 기록 (GREATEST(NULL,t0)=t0)" "$(seen $G2)" "$EP_T0"

echo "[다건 배열 저장 — unnest]"
"${PSQL[@]}" -c "SELECT mark_scheduled_seen(ARRAY['A1','A2','A3'], timestamptz '$T60')" >/dev/null
N=$("${PSQL[@]}" -c "SELECT count(*) FROM game_notify_state WHERE game_id IN ('A1','A2','A3') AND extract(epoch FROM last_seen_scheduled_at)::bigint = $EP_T60")
check "배열 3건 모두 t60 저장" "$N" "3"
# 중복 game_id 포함 배열도 DISTINCT 로 ON CONFLICT 카디널리티 에러 없이 처리
R=$("${PSQL[@]}" -c "SELECT mark_scheduled_seen(ARRAY['A1','A1'], timestamptz '$T120'); SELECT 'ok'" 2>&1 | tail -1)
check "동일 game_id 중복 배열도 에러 없이 처리(distinct)" "$R" "ok"
check "  → A1 은 t120 로 전진" "$(seen A1)" "$EP_T120"

echo "[겹친 write 원자성 — 같은 game_id t0/t60 병렬 후 항상 t60 (락 직렬화)]"
G3=20260724HTNC0
for i in $(seq 1 8); do
  "${PSQL[@]}" -c "DELETE FROM game_notify_state WHERE game_id='$G3'" >/dev/null
  "${PSQL[@]}" -c "SELECT mark_scheduled_seen(ARRAY['$G3'], timestamptz '$T0')" >/dev/null &
  "${PSQL[@]}" -c "SELECT mark_scheduled_seen(ARRAY['$G3'], timestamptz '$T60')" >/dev/null &
  wait
  R=$(seen $G3)
  if [ "$R" != "$EP_T60" ]; then fail=$((fail+1)); echo "  ❌ 병렬 iter=$i 최신 t60 미유지 (got: $R)"; break; fi
  [ "$i" = "8" ] && { pass=$((pass+1)); echo "  ✅ 병렬 t0/t60 8회 반복 모두 t60 유지 (last-write-wins 회귀 시 t0 로 깨짐)"; }
done

echo "[클라 롤 실행 차단]"
R=$("${PSQL[@]}" -c "SELECT has_function_privilege('anon','mark_scheduled_seen(text[],timestamptz)','EXECUTE')")
check "anon EXECUTE 불가" "$R" "f"
R=$("${PSQL[@]}" -c "SELECT has_function_privilege('authenticated','mark_scheduled_seen(text[],timestamptz)','EXECUTE')")
check "authenticated EXECUTE 불가" "$R" "f"
R=$("${PSQL[@]}" -c "SELECT has_function_privilege('service_role','mark_scheduled_seen(text[],timestamptz)','EXECUTE')")
check "service_role EXECUTE 허용" "$R" "t"

echo ""
echo "결과: $pass pass / $fail fail"
[ "$fail" -eq 0 ]
