#!/usr/bin/env bash
# 경기 시작 디바이스 원장 lease/fencing 통합 회귀.
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
MIGRATION="$ROOT/supabase/migrations/20260726_game_start_device_delivery.sql"
REVIEW_ROOT="${OPENCLAW_REVIEW_ROOT:-/Volumes/T7-Dev/reviews}"
[ -d "$REVIEW_ROOT" ] || { echo "review root not found: $REVIEW_ROOT" >&2; exit 1; }
WORK="$(mktemp -d "$REVIEW_ROOT/pr882-ledger-pg17.XXXXXX")"
DATADIR="$WORK/data"
SOCKDIR="$WORK/sock"
mkdir -p "$SOCKDIR"
cleanup() {
  "$PGBIN/pg_ctl" -D "$DATADIR" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATADIR" -A trust -U qa --locale=C --encoding=UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATADIR" -o "-p 59330 -k $SOCKDIR -c listen_addresses=''" -w start >/dev/null
PSQL=("$PGBIN/psql" -h "$SOCKDIR" -p 59330 -U qa -d postgres -v ON_ERROR_STOP=1 -qtA)

"${PSQL[@]}" <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA extensions;
CREATE TABLE game_notify_state (
  game_id text PRIMARY KEY,
  start_notified boolean NOT NULL DEFAULT false,
  end_notified boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE profiles (
  id uuid PRIMARY KEY,
  team_id integer
);
CREATE TABLE notification_prefs (
  user_id uuid PRIMARY KEY,
  game_start boolean
);
CREATE TABLE device_push_tokens (
  id bigint PRIMARY KEY,
  user_id uuid NOT NULL,
  platform text NOT NULL,
  fcm_token text NOT NULL
);
SQL
"${PSQL[@]}" -f "$MIGRATION" >/dev/null

GAME=20260726LGHH0
DEADLINE='2026-07-26T12:30:00Z'
"${PSQL[@]}" <<SQL
INSERT INTO game_notify_state(game_id, start_snapshot_at, start_snapshot_deadline_at)
VALUES ('$GAME', now(), timestamptz '$DEADLINE');
INSERT INTO game_start_delivery_ledger
  (id, game_id, token_id, token_hash, user_id, platform, fcm_token, deadline_at)
VALUES
  ('00000000-0000-0000-0000-000000000001', '$GAME', 1, 'h1',
   '10000000-0000-0000-0000-000000000001', 'android', 'token-1', timestamptz '$DEADLINE');
SQL

LEASE_A=20000000-0000-0000-0000-000000000001
LEASE_B=20000000-0000-0000-0000-000000000002
LEASE_C=20000000-0000-0000-0000-000000000003

# row1: worker A가 20초 lease로 claim. overlap worker B는 0행이어야 한다.
A=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_game_start_deliveries('$GAME','$LEASE_A',20,1)")
B=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_game_start_deliveries('$GAME','$LEASE_B',20,1)")
[ "$A" = "1" ] && [ "$B" = "0" ] || {
  echo "FAIL: active lease overlap A=$A B=$B" >&2
  exit 1
}

# row1 settle 뒤 terminal 행도 재claim되지 않는다.
"${PSQL[@]}" -c "SELECT settle_game_start_deliveries(ARRAY['00000000-0000-0000-0000-000000000001']::uuid[],'$LEASE_A','accepted',null)" >/dev/null
TERMINAL=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_game_start_deliveries('$GAME','$LEASE_C',20,2)")
[ "$TERMINAL" = "0" ] || { echo "FAIL: accepted/active rows reclaimed=$TERMINAL" >&2; exit 1; }

# row2는 worker B claim 뒤 crash(미settle). lease 만료를 시계 전진으로 재현하면 deadline 전 재claim된다.
"${PSQL[@]}" <<SQL >/dev/null
INSERT INTO game_start_delivery_ledger
  (id, game_id, token_id, token_hash, user_id, platform, fcm_token, deadline_at)
VALUES
  ('00000000-0000-0000-0000-000000000002', '$GAME', 2, 'h2',
   '10000000-0000-0000-0000-000000000002', 'ios', 'token-2', timestamptz '$DEADLINE');
SELECT count(*) FROM claim_game_start_deliveries('$GAME','$LEASE_B',20,1);
SQL
CRASHED=$("${PSQL[@]}" -c "SELECT count(*) FROM game_start_delivery_ledger WHERE id='00000000-0000-0000-0000-000000000002' AND status='leased' AND lease_token='$LEASE_B'")
[ "$CRASHED" = "1" ] || { echo "FAIL: crash setup lease missing" >&2; exit 1; }
"${PSQL[@]}" -c "UPDATE game_start_delivery_ledger SET lease_until=now()-interval '1 second' WHERE id='00000000-0000-0000-0000-000000000002'" >/dev/null
RECOVERED=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_game_start_deliveries('$GAME','$LEASE_C',20,2)")
[ "$RECOVERED" = "1" ] || { echo "FAIL: crashed lease was not reclaimed before deadline" >&2; exit 1; }
ATTEMPTS=$("${PSQL[@]}" -c "SELECT attempts FROM game_start_delivery_ledger WHERE id='00000000-0000-0000-0000-000000000002'")
[ "$ATTEMPTS" = "2" ] || { echo "FAIL: crash retry attempts=$ATTEMPTS" >&2; exit 1; }

echo "PASS PG17 game-start ledger: active overlap 0, terminal reclaim 0, crash retry 1, attempts 2"
