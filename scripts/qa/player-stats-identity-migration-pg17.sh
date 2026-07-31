#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
TMP_PARENT="${OPENCLAW_REVIEW_ROOT:-$ROOT/.tmp}"
mkdir -p "$TMP_PARENT"
TMP_DIR="$(mktemp -d "$TMP_PARENT/player-stats-pg17.XXXXXX")"
PORT="${PLAYER_STATS_PG_PORT:-55439}"

cleanup() {
  "$PG_BIN/pg_ctl" -D "$TMP_DIR/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

"$PG_BIN/initdb" -D "$TMP_DIR/data" -A trust --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$TMP_DIR/data" -o "-p $PORT -k $TMP_DIR" -w start >/dev/null
PSQL=("$PG_BIN/psql" -h "$TMP_DIR" -p "$PORT" -d postgres -v ON_ERROR_STOP=1 -Atq)

"${PSQL[@]}" <<'SQL'
CREATE TABLE player_stats_batter (
  name text NOT NULL,
  team text NOT NULL,
  kbo_id text,
  updated_at timestamptz,
  PRIMARY KEY (name, team)
);
CREATE TABLE player_stats_pitcher (
  name text NOT NULL,
  team text NOT NULL,
  kbo_id text,
  updated_at timestamptz,
  PRIMARY KEY (name, team)
);
INSERT INTO player_stats_pitcher(name, team, kbo_id, updated_at) VALUES
  ('김윤식', 'LG', NULL, '2026-07-30T00:00:00Z'),
  ('미야지', '삼성', NULL, '2026-07-30T00:00:00Z');
SQL

"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260731144000_player_stats_durable_identity.sql" >/dev/null

"${PSQL[@]}" <<'SQL'
INSERT INTO player_stats_pitcher(name, team, kbo_id, player_key, updated_at) VALUES
  ('김윤식', 'LG', '50157', '50157', '2026-07-31T00:00:00Z'),
  ('미야지', '삼성', 'AQ003', 'AQ003', '2026-07-31T00:00:00Z')
ON CONFLICT (player_key) DO UPDATE SET
  name = EXCLUDED.name,
  team = EXCLUDED.team,
  kbo_id = EXCLUDED.kbo_id,
  updated_at = EXCLUDED.updated_at;

-- 같은 이름·팀의 실제 동명이인은 서로 다른 durable ID면 별도 행이어야 한다.
INSERT INTO player_stats_pitcher(name, team, kbo_id, player_key, updated_at)
VALUES ('김윤식', 'LG', '99999', '99999', '2026-07-31T00:00:00Z');
SQL

ghosts="$("${PSQL[@]}" -c "SELECT count(*) FROM player_stats_pitcher WHERE player_key LIKE 'legacy:%'")"
known_rows="$("${PSQL[@]}" -c "SELECT count(*) FROM player_stats_pitcher WHERE (name, team, player_key, kbo_id) IN (('김윤식','LG','50157','50157'),('미야지','삼성','AQ003','AQ003'))")"
doppel_rows="$("${PSQL[@]}" -c "SELECT count(*) FROM player_stats_pitcher WHERE name='김윤식' AND team='LG'")"

test "$ghosts" = "0"
test "$known_rows" = "2"
test "$doppel_rows" = "2"

echo "player-stats identity migration PG17: ghost=0 known=2 doppelgängers=2 PASS"
