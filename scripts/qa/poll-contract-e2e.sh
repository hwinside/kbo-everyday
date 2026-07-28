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
  -- 운영 카운터/블라인드 컬럼(실제 posts 스키마 반영: 20260720_report_blind_notice,
  -- 20260721_post_view_counts + base like_count/comment_count). 이 컬럼들에 대한
  -- 정상 UPDATE 가 poll_posts_edit_lock 회귀로 막히지 않는지 실 PG17 로 고정한다.
  report_count integer NOT NULL DEFAULT 0,
  is_hidden boolean NOT NULL DEFAULT false,
  click_view_count integer NOT NULL DEFAULT 0,
  impression_view_count integer NOT NULL DEFAULT 0,
  like_count integer NOT NULL DEFAULT 0,
  comment_count integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(), updated_at timestamptz);
GRANT SELECT, INSERT, UPDATE ON public.posts TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.posts_id_seq TO authenticated;

-- 신고 → 자동 블라인드 경로(실제 20260720_report_blind_notice auto_blind_on_report
-- post 분기 최소 반영: report_count += 1, 임계 3 도달 시 is_hidden 전환). 이 경로가
-- posts 를 UPDATE 하므로 poll 글에도 정상 동작해야(회귀 검출용) 한다.
CREATE TABLE IF NOT EXISTS public.reports (
  id bigserial PRIMARY KEY,
  target_type text NOT NULL,
  target_id bigint NOT NULL,
  reporter_id uuid,
  created_at timestamptz DEFAULT now(),
  UNIQUE (target_type, target_id, reporter_id));
CREATE OR REPLACE FUNCTION public.auto_blind_on_report()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NEW.target_type = 'post' THEN
    UPDATE posts SET report_count = report_count + 1 WHERE id = NEW.target_id;
    UPDATE posts SET is_hidden = true
      WHERE id = NEW.target_id AND is_hidden = false AND report_count >= 3;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_auto_blind ON public.reports;
CREATE TRIGGER trg_auto_blind AFTER INSERT ON public.reports
  FOR EACH ROW EXECUTE FUNCTION public.auto_blind_on_report();
SQL

echo "[poll-e2e] apply migration ..."
psql -q -f "$MIG" >/dev/null
echo "[poll-e2e] reapply migration (idempotency) ..."
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

echo "[poll-e2e] DB harness PASS ✅ (①②④⑤⑦⑧⑨ + direct poll-post write guard + duplicate ref RPC guard + tag-write + 운영경로(신고·카운터·투표전편집) 회귀 + ⑥ 20-way concurrency; migration reapplied)"
echo "[poll-e2e] route contracts ③/⑩ + hidden GET/OG + canonical snapshot/duplicate ref → scripts/qa/poll-route-e2e.ts (npm run qa:poll-route)"
