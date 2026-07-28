#!/usr/bin/env bash
# S2 Slice0 (삼순 4차 NO-GO #1) — actual notifyScoreEvents() × 실 Postgres 통합 회귀 부팅 래퍼.
# PG17을 부팅해 마이그레이션+최소 스키마를 로드하고, env를 주입해 game-event-notify-pg17.ts(tsx)를 구동한다.
# 진짜 notifyScoreEvents()가 psql-backed supabaseAdmin.rpc shim을 통해 실 원장 RPC를 실행한다.
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

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20260727_game_event_token_ledger.sql"
REVIEW_ROOT="${OPENCLAW_REVIEW_ROOT:-/Volumes/T7-Dev/reviews}"
[ -d "$REVIEW_ROOT" ] || { echo "review root not found: $REVIEW_ROOT" >&2; exit 1; }
WORK="$(mktemp -d "$REVIEW_ROOT/game-event-notify-pg17.XXXXXX")"
DATADIR="$WORK/data"
SOCKDIR="$WORK/sock"
mkdir -p "$SOCKDIR"
cleanup() {
  "$PGBIN/pg_ctl" -D "$DATADIR" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

PGPORT=59341
"$PGBIN/initdb" -D "$DATADIR" -A trust -U qa --locale=C --encoding=UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATADIR" -o "-p $PGPORT -k $SOCKDIR -c listen_addresses=''" -w start >/dev/null
PSQL=("$PGBIN/psql" -h "$SOCKDIR" -p "$PGPORT" -U qa -d postgres -v ON_ERROR_STOP=1 -qtA)

"${PSQL[@]}" <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA extensions;
CREATE TABLE profiles (id uuid PRIMARY KEY, team_id integer);
CREATE TABLE notification_prefs (
  user_id uuid PRIMARY KEY,
  my_team_score boolean,
  my_team_concede boolean,
  my_team_score_inning_summary boolean
);
CREATE TABLE device_push_tokens (
  id bigint PRIMARY KEY,
  user_id uuid NOT NULL,
  platform text NOT NULL,
  app_build integer,
  fcm_token text NOT NULL
);
CREATE TABLE notified_score_events (event_id text PRIMARY KEY, game_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
SQL
"${PSQL[@]}" -f "$MIGRATION" >/dev/null

export PSQL_BIN="$PGBIN/psql"
export PGHOST="$SOCKDIR"
export PGPORT="$PGPORT"
export PGUSER="qa"
export PGDATABASE="postgres"

cd "$ROOT"
npx tsx scripts/qa/game-event-notify-pg17.ts
