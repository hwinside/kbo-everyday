#!/usr/bin/env bash
# 경기요약 claim의 동일 fingerprint single-flight / stale takeover DB 통합 회귀.
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
FENCE_MIGRATION="$ROOT/supabase/migrations/20260726_game_summary_generation_fence.sql"
SINGLE_FLIGHT_MIGRATION="$ROOT/supabase/migrations/20260728_game_summary_single_flight.sql"
REVIEW_ROOT="${OPENCLAW_REVIEW_ROOT:-/Volumes/T7-Dev/reviews}"
[ -d "$REVIEW_ROOT" ] || { echo "review root not found: $REVIEW_ROOT" >&2; exit 1; }
WORK="$(mktemp -d "$REVIEW_ROOT/game-summary-single-flight-pg17.XXXXXX")"
DATADIR="$WORK/data"
SOCKDIR="$WORK/sock"
mkdir -p "$SOCKDIR"

cleanup() {
  "$PGBIN/pg_ctl" -D "$DATADIR" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATADIR" -A trust -U qa --locale=C --encoding=UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATADIR" -o "-p 59335 -k $SOCKDIR -c listen_addresses=''" -w start >/dev/null
PSQL=("$PGBIN/psql" -h "$SOCKDIR" -p 59335 -U qa -d postgres -v ON_ERROR_STOP=1 -qtA)

"${PSQL[@]}" <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE TABLE game_summaries (
  game_id text PRIMARY KEY,
  summary jsonb NOT NULL,
  prompt_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
SQL
"${PSQL[@]}" -f "$FENCE_MIGRATION" >/dev/null
"${PSQL[@]}" -f "$SINGLE_FLIGHT_MIGRATION" >/dev/null

GAME=20260728WOLG0
FINGERPRINT='{"status":"final","awayScore":3,"homeScore":5,"awayInnings":[0,0,0,0,0,0,3,0,0],"homeInnings":[0,0,0,2,0,3,0,0,null]}'

for i in $(seq 1 20); do
  "${PSQL[@]}" -c "SELECT
    claim->>'generation_token',
    claim->>'should_generate'
  FROM (
    SELECT claim_game_summary_generation_singleflight(
      '$GAME',
      '$FINGERPRINT'::jsonb,
      120
    ) AS claim
  ) q" >"$WORK/claim.$i" &
done
wait

LEADERS=$(awk -F'|' '$2=="true"{n++} END{print n+0}' "$WORK"/claim.*)
TOKENS=$(cut -d'|' -f1 "$WORK"/claim.* | sort -u | wc -l | tr -d ' ')
SEQUENCE_VALUE=$("${PSQL[@]}" -c "SELECT last_value FROM game_summary_generation_seq")
[ "$LEADERS" = "1" ] || { echo "FAIL: concurrent leaders=$LEADERS expected=1" >&2; exit 1; }
[ "$TOKENS" = "1" ] || { echo "FAIL: concurrent tokens=$TOKENS expected=1" >&2; exit 1; }
[ "$SEQUENCE_VALUE" = "1" ] || { echo "FAIL: follower consumed sequence, last_value=$SEQUENCE_VALUE" >&2; exit 1; }

OLD_TOKEN=$(head -1 "$WORK/claim.1" | cut -d'|' -f1)
LEGACY_TOKEN=$("${PSQL[@]}" -c "SELECT claim_game_summary_generation('$GAME')")
LEGACY_SEQUENCE_VALUE=$("${PSQL[@]}" -c "SELECT last_value FROM game_summary_generation_seq")
[ "$LEGACY_TOKEN" = "$OLD_TOKEN" ] && [ "$LEGACY_SEQUENCE_VALUE" = "1" ] || {
  echo "FAIL: rollout-compatible old RPC superseded fresh claim token=$LEGACY_TOKEN sequence=$LEGACY_SEQUENCE_VALUE" >&2
  exit 1
}

DIFFERENT=$("${PSQL[@]}" -c "SELECT
  (claim->>'generation_token')||'|'||(claim->>'should_generate')
FROM (
  SELECT claim_game_summary_generation_singleflight(
    '$GAME',
    jsonb_set('$FINGERPRINT'::jsonb, '{homeScore}', '6'::jsonb),
    120
  ) AS claim
) q")
NEW_TOKEN=${DIFFERENT%%|*}
NEW_IS_LEADER=${DIFFERENT##*|}
[ "$NEW_IS_LEADER" = "true" ] && [ "$NEW_TOKEN" -gt "$OLD_TOKEN" ] || {
  echo "FAIL: changed fingerprint did not takeover ($DIFFERENT)" >&2
  exit 1
}

OLD_SAVE=$("${PSQL[@]}" -c "SELECT save_game_summary_if_current('$GAME',$OLD_TOKEN,'{\"old\":true}'::jsonb,11)")
NEW_SAVE=$("${PSQL[@]}" -c "SELECT save_game_summary_if_current('$GAME',$NEW_TOKEN,'{\"new\":true}'::jsonb,11)")
[ "$OLD_SAVE" = "f" ] && [ "$NEW_SAVE" = "t" ] || {
  echo "FAIL: save fence old=$OLD_SAVE new=$NEW_SAVE" >&2
  exit 1
}

"${PSQL[@]}" -c "UPDATE game_summary_generation_claims SET claimed_at=now()-interval '121 seconds' WHERE game_id='$GAME'" >/dev/null
STALE=$("${PSQL[@]}" -c "SELECT
  (claim->>'generation_token')||'|'||(claim->>'should_generate')
FROM (
  SELECT claim_game_summary_generation_singleflight(
    '$GAME',
    source_fingerprint,
    120
  ) AS claim
  FROM game_summary_generation_claims
  WHERE game_id='$GAME'
) q")
STALE_TOKEN=${STALE%%|*}
STALE_IS_LEADER=${STALE##*|}
[ "$STALE_IS_LEADER" = "true" ] && [ "$STALE_TOKEN" -gt "$NEW_TOKEN" ] || {
  echo "FAIL: stale claim did not takeover ($STALE)" >&2
  exit 1
}

# Reapplying the migration must preserve the live contract.
"${PSQL[@]}" -f "$SINGLE_FLIGHT_MIGRATION" >/dev/null

echo "game-summary-single-flight-pg17: PASS (20-way leader=1, token=1, changed/stale takeover, save fence)"
