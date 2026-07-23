#!/bin/bash
# leaderboard_writing_rollup_refresh() 회귀 — 삼순 #802 NO-GO 2건 (pre-merge 실증)
#
# 임시 로컬 PostgreSQL 클러스터(initdb→pg_ctl)에 최소 스키마 + 실제 마이그레이션
# 파일을 그대로 적용한 뒤 검증한다. 운영 DB는 일절 건드리지 않는다.
#
#  ① 동시성: 세션 A가 advisory xact lock 보유 중 세션 B refresh 호출
#     → 'skipped_lock_busy' 반환 + PK 충돌/에러 0 (락 해제 후엔 'refreshed')
#  ② NULL actor: 4개 소스 컬럼(chat_messages.user_id, comments/posts/
#     ticket_transfers.author_id)에 NULL 행 주입 → refresh 성공 + rollup에
#     NULL user_id 0행 (기존 뷰의 <> ALL() 암묵 NULL 제외 의미론 보존)
#
# 사용: bash scripts/qa/leaderboard-rollup-refresh-regression.sh
#       (PGBIN으로 postgres bin 경로 재정의 가능)
set -euo pipefail
export LC_ALL=C  # macOS: 비유효 로케일이면 postmaster multithreaded fatal

PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
[ -x "$PGBIN/initdb" ] || { echo "SKIP: postgres binaries not found at $PGBIN (set PGBIN)"; exit 0; }

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20260723_leaderboard_writing_rollup.sql"
TMP="$(mktemp -d)"
PORT=55432
trap '"$PGBIN/pg_ctl" -D "$TMP/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT

"$PGBIN/initdb" -D "$TMP/data" -A trust -U postgres --locale=C --encoding=UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/pg.log" start >/dev/null
PSQL=("$PGBIN/psql" -h "$TMP" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA)

# ── 최소 스키마 (마이그레이션이 참조하는 대상만; NULL 허용 = 운영과 동일) ──
"${PSQL[@]}" <<'SQL'
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE profiles (id uuid PRIMARY KEY, nickname text, team_id int, is_bot boolean DEFAULT false);
CREATE TABLE chat_messages (id bigint GENERATED ALWAYS AS IDENTITY, user_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE comments (id bigint GENERATED ALWAYS AS IDENTITY, author_id uuid, created_at timestamptz NOT NULL DEFAULT now(), is_hidden boolean NOT NULL DEFAULT false);
CREATE TABLE posts (id bigint GENERATED ALWAYS AS IDENTITY, author_id uuid, created_at timestamptz NOT NULL DEFAULT now(), is_hidden boolean NOT NULL DEFAULT false, content_type text, board_type text, board_id text);
CREATE TABLE ticket_transfers (id bigint GENERATED ALWAYS AS IDENTITY, author_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION leaderboard_internal_user_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[]::uuid[] $$;
SQL

"${PSQL[@]}" -f "$MIGRATION" >/dev/null
echo "migration applied on ephemeral cluster (pg17)"

pass=0; fail=0
check() { # label got want
  if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "✗ $1: got [$2] want [$3]"; fi
}

# ── 기본 동작: 픽스처 적재 → refresh → rollup 반영 ──
U1=11111111-1111-1111-1111-111111111111
U2=22222222-2222-2222-2222-222222222222
"${PSQL[@]}" <<SQL
INSERT INTO profiles (id, nickname) VALUES ('$U1','팬1'), ('$U2','팬2');
INSERT INTO chat_messages (user_id) VALUES ('$U1'), ('$U1');
INSERT INTO posts (author_id) VALUES ('$U2');
SQL
check "refresh returns refreshed" "$("${PSQL[@]}" -c 'SELECT leaderboard_writing_rollup_refresh()')" "refreshed"
check "rollup rows" "$("${PSQL[@]}" -c 'SELECT count(*) FROM leaderboard_writing_rollup')" "2"

# ── ① 동시성: 세션 A가 락 보유(3s) 중 세션 B refresh → skip, 에러 0 ──
"${PSQL[@]}" -c "BEGIN; SELECT pg_advisory_xact_lock(hashtext('leaderboard_writing_rollup_refresh')); SELECT pg_sleep(3); COMMIT;" >/dev/null &
HOLDER=$!
sleep 1
check "concurrent refresh skipped" "$("${PSQL[@]}" -c 'SELECT leaderboard_writing_rollup_refresh()')" "skipped_lock_busy"
check "skip leaves snapshot intact" "$("${PSQL[@]}" -c 'SELECT count(*) FROM leaderboard_writing_rollup')" "2"
wait "$HOLDER"
check "refresh after lock released" "$("${PSQL[@]}" -c 'SELECT leaderboard_writing_rollup_refresh()')" "refreshed"

# ── ② NULL actor 4종 주입 → refresh 성공 + rollup NULL 0행 + 점수 불변 ──
"${PSQL[@]}" <<'SQL'
INSERT INTO chat_messages (user_id) VALUES (NULL);
INSERT INTO comments (author_id) VALUES (NULL);
INSERT INTO posts (author_id) VALUES (NULL);
INSERT INTO ticket_transfers (author_id) VALUES (NULL);
SQL
check "refresh survives NULL actors" "$("${PSQL[@]}" -c 'SELECT leaderboard_writing_rollup_refresh()')" "refreshed"
check "no NULL user_id in rollup" "$("${PSQL[@]}" -c 'SELECT count(*) FROM leaderboard_writing_rollup WHERE user_id IS NULL')" "0"
check "scores unchanged by NULL rows" "$("${PSQL[@]}" -c 'SELECT count(*) FROM leaderboard_writing_rollup')" "2"
check "view still serves rows" "$("${PSQL[@]}" -c 'SELECT count(*) FROM v_leaderboard_writing')" "2"

echo "leaderboard-rollup refresh regression: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
