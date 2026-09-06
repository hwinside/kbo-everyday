#!/usr/bin/env bash
# Disposable, socket-only PostgreSQL; never connects to application/production DB.
set -euo pipefail
# Keep initdb/pg_ctl safe under macOS locale initialization.
export LC_ALL=C
export LANG=C
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
GIPHY_QA_BACKEND="${GIPHY_QA_BACKEND:-auto}"
case "$GIPHY_QA_BACKEND" in
  auto|native|pglite) ;;
  *) echo 'FAIL: GIPHY_QA_BACKEND must be auto, native, or pglite' >&2; exit 1 ;;
esac
TMP_PARENT="${OPENCLAW_REVIEW_ROOT:-$ROOT/.tmp}"
mkdir -p "$TMP_PARENT"
GIPHY_TEST_DIR="$(mktemp -d "$TMP_PARENT/giphy-popular-pg17.XXXXXX")"
cleanup() {
  if [[ -d "$GIPHY_TEST_DIR/data" ]]; then
    "$PG_BIN/pg_ctl" -D "$GIPHY_TEST_DIR/data" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "$GIPHY_TEST_DIR"
}
trap cleanup EXIT
# Both native PG17 and the portable deploy backend consume this exact fixture.
GIPHY_SQL="$GIPHY_TEST_DIR/fixture.sql"
cat >"$GIPHY_SQL" <<'SQL'
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE TABLE public.chat_messages (
  id bigserial PRIMARY KEY, room_id text NOT NULL, user_id uuid,
  content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.chat_messages TO service_role;
INSERT INTO public.chat_messages (room_id, content, created_at)
SELECT 'game:test', 'https://media.giphy.com/media/olderWinner/giphy.gif', now() - interval '2 days'
FROM generate_series(1, 1200);
INSERT INTO public.chat_messages (room_id, content)
SELECT 'game:test', 'https://media.giphy.com/media/recentRunner/giphy.gif' FROM generate_series(1, 1000);
INSERT INTO public.chat_messages (room_id, content, created_at, deleted_at) VALUES
 ('game:test', 'https://media.giphy.com/media/expired/giphy.gif', now() - interval '31 days', null),
 ('game:test', 'https://media.giphy.com/media/future/giphy.gif', now() + interval '1 day', null),
 ('game:test', 'https://media.giphy.com/media/deleted/giphy.gif', now(), now()),
 ('team:test', 'https://media.giphy.com/media/private/giphy.gif', now(), null),
 ('game:test', 'https://media.giphy.com.evil.test/media/spoof/giphy.gif', now(), null),
 ('game:test', 'https://media4.giphy.com/media/v1.fixture/legacyId/200.gif?cid=fixture', now(), null),
 ('game:test', 'plain text', now(), null);
SQL
cat "$ROOT/supabase/migrations/20260906194000_popular_game_chat_giphy_ids.sql" >>"$GIPHY_SQL"
# Also verify idempotent application.
cat "$ROOT/supabase/migrations/20260906194000_popular_game_chat_giphy_ids.sql" >>"$GIPHY_SQL"
cat >>"$GIPHY_SQL" <<'SQL'
DO $$
DECLARE ids text[];
BEGIN
 SELECT array_agg(gif_id) INTO ids FROM public.popular_game_chat_giphy_ids();
 IF ids IS DISTINCT FROM ARRAY['olderWinner','recentRunner','legacyId'] THEN
   RAISE EXCEPTION 'full-window ordering/exclusions failed: %', ids;
 END IF;
 IF has_function_privilege('anon', 'public.popular_game_chat_giphy_ids()', 'execute')
 OR has_function_privilege('authenticated', 'public.popular_game_chat_giphy_ids()', 'execute')
 OR NOT has_function_privilege('service_role', 'public.popular_game_chat_giphy_ids()', 'execute') THEN
   RAISE EXCEPTION 'RPC role boundary failed';
 END IF;
END $$;
SET ROLE service_role;
DO $$ BEGIN
 IF (SELECT count(*) FROM public.popular_game_chat_giphy_ids()) <> 3 THEN
   RAISE EXCEPTION 'service-role RLS access failed';
 END IF;
END $$;
RESET ROLE;
INSERT INTO public.chat_messages(room_id, content)
SELECT 'game:test', 'https://media.giphy.com/media/extra' || n || '/giphy.gif'
FROM generate_series(1, 40) n;
DO $$ BEGIN
 IF (SELECT count(*) FROM public.popular_game_chat_giphy_ids()) <> 24 THEN
   RAISE EXCEPTION '24-ID hard bound failed';
 END IF;
END $$;
UPDATE public.chat_messages SET deleted_at = now();
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.popular_game_chat_giphy_ids()) THEN
   RAISE EXCEPTION 'all-deleted catalog must be empty';
 END IF;
END $$;
SQL
if [[ "$GIPHY_QA_BACKEND" != pglite && -x "$PG_BIN/initdb" && -x "$PG_BIN/pg_ctl" && -x "$PG_BIN/psql" ]]; then
  "$PG_BIN/initdb" --version | grep -Eq ' 17([.]|$)' || { echo 'FAIL: PostgreSQL 17 required' >&2; exit 1; }
  "$PG_BIN/initdb" -D "$GIPHY_TEST_DIR/data" -A trust --no-locale >/dev/null
  "$PG_BIN/pg_ctl" -D "$GIPHY_TEST_DIR/data" -o "-p 55447 -k $GIPHY_TEST_DIR -c listen_addresses=''" -w start >/dev/null
  "$PG_BIN/psql" -h "$GIPHY_TEST_DIR" -p 55447 -d postgres -v ON_ERROR_STOP=1 -Atq -f "$GIPHY_SQL"
  echo 'Backend: native PostgreSQL 17'
elif [[ "$GIPHY_QA_BACKEND" == native || ( "$GIPHY_QA_BACKEND" != pglite && -n "${PG17_BIN:-}" ) ]]; then
  echo 'FAIL: explicitly configured PG17_BIN is missing required binaries' >&2
  exit 1
else
  # Vercel/CI need no Homebrew, PostgreSQL service, or production credentials.
  node "$ROOT/scripts/qa/giphy-popular-ids-pglite.mjs" "$GIPHY_SQL"
fi
printf '%s\n' 'PASS popular IDs: >1000-row full window, rank, exclusions, legacy URL, grants, cap, empty, idempotence'
