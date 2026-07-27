#!/usr/bin/env bash
# ============================================================
# 커뮤니티 투표(Poll) S1 — 서버 계약 E2E 러너
#   throwaway 로컬 Postgres 클러스터를 띄워 migration 을 적용하고
#   scripts/qa/poll-contract-e2e.sql 의 assert(①–⑩) 와 동시성(⑥)을 검증한다.
#   ⚠️ 운영/스테이징 DB 를 절대 건드리지 않는다 (완전 격리 tmp 클러스터).
#
# 요구: postgresql@17 바이너리 (Homebrew). 없으면 SKIP(비차단) 처리.
# 사용: bash scripts/qa/poll-contract-e2e.sh
# ============================================================
set -euo pipefail

PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
if [[ ! -x "$PGBIN/initdb" ]]; then
  # PATH 상의 initdb fallback
  if command -v initdb >/dev/null 2>&1; then PGBIN="$(dirname "$(command -v initdb)")"; else
    echo "[poll-e2e] SKIP: postgresql@17 binaries not found ($PGBIN). brew install postgresql@17"
    exit 0
  fi
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIG="$ROOT/supabase/migrations/20260727_community_poll.sql"
SQL="$ROOT/scripts/qa/poll-contract-e2e.sql"

WORK="${OPENCLAW_REVIEW_ROOT:-/tmp}/poll-e2e.$$"
export PGDATA="$WORK/data"
export PGHOST="$WORK/sock"
export PGPORT="${PGPORT:-55432}"
export LC_ALL=C LANG=C
mkdir -p "$PGHOST"

cleanup() { "$PGBIN/pg_ctl" -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

echo "[poll-e2e] initdb ($WORK) ..."
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust --no-locale -E UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$PGDATA" -o "-k $PGHOST -p $PGPORT -c listen_addresses=''" -l "$WORK/pg.log" start >/dev/null
sleep 1

psql() { "$PGBIN/psql" -h "$PGHOST" -p "$PGPORT" -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }

echo "[poll-e2e] bootstrap shim (roles/auth.users/posts) ..."
psql -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text);
CREATE TABLE IF NOT EXISTS public.posts (
  id bigserial PRIMARY KEY, author_id uuid,
  board_type text NOT NULL DEFAULT 'team', board_id text NOT NULL,
  title text NOT NULL, content text NOT NULL,
  team_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  player_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now(), updated_at timestamptz);
SQL

echo "[poll-e2e] apply migration ..."
psql -q -f "$MIG" >/dev/null

echo "[poll-e2e] run assertions ..."
psql -f "$SQL" 2>&1 | grep -E "PASS|FAIL|ERROR|COMPLETE|status|NOTICE" | sed 's/^psql.*NOTICE:  //'

# ---------- ⑥ 동시성: 20 유저 병렬 투표 → stale 없음 ----------
echo "[poll-e2e] ⑥ concurrency (20 parallel voters) ..."
psql -q -c "INSERT INTO auth.users(id) SELECT ('770000000000000000000000000000'||to_char(g,'FM00'))::uuid FROM generate_series(1,20) g ON CONFLICT DO NOTHING;"
PID2=$(psql -qAt -c "SELECT create_poll('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','stress?',null,false,now()+interval '1 day','[{\"kind\":\"etc\",\"label\":\"a\"},{\"kind\":\"etc\",\"label\":\"b\"}]'::jsonb);")
OA=$(psql -qAt -c "SELECT id FROM poll_options WHERE post_id=$PID2 ORDER BY position LIMIT 1;")
for i in $(seq 1 20); do
  U="770000000000000000000000000000$(printf '%02d' "$i")"
  psql -qAt -c "SELECT cast_poll_vote($PID2,'$U'::uuid,ARRAY[$OA::bigint]);" >/dev/null 2>&1 &
done
wait
VC=$(psql -qAt -c "SELECT voter_count FROM poll_polls WHERE post_id=$PID2;")
OC=$(psql -qAt -c "SELECT vote_count FROM poll_options WHERE id=$OA;")
TV=$(psql -qAt -c "SELECT count(*) FROM poll_votes WHERE post_id=$PID2;")
if [[ "$VC" == "20" && "$OC" == "20" && "$TV" == "20" ]]; then
  echo "PASS ⑥ 20 parallel voters → voter_count=$VC option=$OC total=$TV (no stale, poll-row lock)"
else
  echo "FAIL ⑥ concurrency: voter_count=$VC option=$OC total=$TV (expected 20/20/20)"; exit 1
fi

echo "[poll-e2e] DB harness PASS ✅ (①②④⑤⑦⑧⑨ + ⑨-2 2-step bypass + 축1축2 tag-write + ⑥ 20-way concurrency)"
echo "[poll-e2e] route contracts ③(closed non-voter results) ⑩(private,no-store) + 축2 ref-validation → scripts/qa/poll-route-e2e.ts (npm run qa:poll-route)"
