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
  game_start boolean,
  fav_player_highlight boolean,
  fav_player_strikeout boolean
);
CREATE TABLE device_push_tokens (
  id bigint PRIMARY KEY,
  user_id uuid NOT NULL,
  platform text NOT NULL,
  fcm_token text NOT NULL
);
CREATE TABLE notified_score_events (
  event_id text PRIMARY KEY,
  game_id text NOT NULL
);
SQL
"${PSQL[@]}" -f "$MIGRATION" >/dev/null

GAME=20260726LGHH0
"${PSQL[@]}" <<SQL
INSERT INTO game_notify_state(game_id, start_snapshot_at, start_snapshot_deadline_at)
VALUES ('$GAME', now(), now() + interval '5 minutes');
INSERT INTO game_start_delivery_ledger
  (id, game_id, token_id, token_hash, user_id, platform, fcm_token, deadline_at)
VALUES
  ('00000000-0000-0000-0000-000000000001', '$GAME', 1, 'h1',
   '10000000-0000-0000-0000-000000000001', 'android', 'token-1', now() + interval '5 minutes');
SQL

LEASE_A=20000000-0000-0000-0000-000000000001
LEASE_B=20000000-0000-0000-0000-000000000002
LEASE_C=20000000-0000-0000-0000-000000000003

# row1: worker A가 45초 lease로 claim. overlap worker B는 0행이어야 한다.
A=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_game_start_deliveries('$GAME','$LEASE_A',45,1)")
B=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_game_start_deliveries('$GAME','$LEASE_B',45,1)")
[ "$A" = "1" ] && [ "$B" = "0" ] || {
  echo "FAIL: active lease overlap A=$A B=$B" >&2
  exit 1
}

# row1 settle 뒤 terminal 행도 재claim되지 않는다.
"${PSQL[@]}" -c "SELECT settle_game_start_deliveries(ARRAY['00000000-0000-0000-0000-000000000001']::uuid[],'$LEASE_A','accepted',null)" >/dev/null
TERMINAL=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_game_start_deliveries('$GAME','$LEASE_C',45,2)")
[ "$TERMINAL" = "0" ] || { echo "FAIL: accepted/active rows reclaimed=$TERMINAL" >&2; exit 1; }

# row2는 worker B claim 뒤 crash(미settle). lease 만료를 시계 전진으로 재현하면 deadline 전 재claim된다.
"${PSQL[@]}" <<SQL >/dev/null
INSERT INTO game_start_delivery_ledger
  (id, game_id, token_id, token_hash, user_id, platform, fcm_token, deadline_at)
VALUES
  ('00000000-0000-0000-0000-000000000002', '$GAME', 2, 'h2',
   '10000000-0000-0000-0000-000000000002', 'ios', 'token-2', now() + interval '5 minutes');
SELECT count(*) FROM claim_game_start_deliveries('$GAME','$LEASE_B',45,1);
SQL
CRASHED=$("${PSQL[@]}" -c "SELECT count(*) FROM game_start_delivery_ledger WHERE id='00000000-0000-0000-0000-000000000002' AND status='leased' AND lease_token='$LEASE_B'")
[ "$CRASHED" = "1" ] || { echo "FAIL: crash setup lease missing" >&2; exit 1; }
"${PSQL[@]}" -c "UPDATE game_start_delivery_ledger SET lease_until=now()-interval '1 second' WHERE id='00000000-0000-0000-0000-000000000002'" >/dev/null
RECOVERED=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_game_start_deliveries('$GAME','$LEASE_C',45,2)")
[ "$RECOVERED" = "1" ] || { echo "FAIL: crashed lease was not reclaimed before deadline" >&2; exit 1; }
ATTEMPTS=$("${PSQL[@]}" -c "SELECT attempts FROM game_start_delivery_ledger WHERE id='00000000-0000-0000-0000-000000000002'")
[ "$ATTEMPTS" = "2" ] || { echo "FAIL: crash retry attempts=$ATTEMPTS" >&2; exit 1; }

# row3: durable dispatch intent 뒤에는 accepted→settle stall/worker crash가 나도 재claim하지 않는다.
"${PSQL[@]}" <<SQL >/dev/null
INSERT INTO game_start_delivery_ledger
  (id, game_id, token_id, token_hash, user_id, platform, fcm_token, deadline_at)
VALUES
  ('00000000-0000-0000-0000-000000000003', '$GAME', 3, 'h3',
   '10000000-0000-0000-0000-000000000003', 'android', 'token-3', now() + interval '5 minutes');
SELECT count(*) FROM claim_game_start_deliveries('$GAME','$LEASE_A',45,1);
SELECT mark_game_start_deliveries_dispatching(
  ARRAY['00000000-0000-0000-0000-000000000003']::uuid[], '$LEASE_A'
);
UPDATE game_start_delivery_ledger
   SET lease_until=now()-interval '1 second'
 WHERE id='00000000-0000-0000-0000-000000000003';
SQL
POST_ACCEPT_RECLAIM=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_game_start_deliveries('$GAME','$LEASE_C',45,1)")
[ "$POST_ACCEPT_RECLAIM" = "0" ] || {
  echo "FAIL: dispatch-intent row reclaimed after accepted/settle stall=$POST_ACCEPT_RECLAIM" >&2
  exit 1
}

# row4: transient settle은 45초 backoff라 같은 invocation에서 즉시 재소진되지 않는다.
"${PSQL[@]}" <<SQL >/dev/null
INSERT INTO game_start_delivery_ledger
  (id, game_id, token_id, token_hash, user_id, platform, fcm_token, deadline_at)
VALUES
  ('00000000-0000-0000-0000-000000000004', '$GAME', 4, 'h4',
   '10000000-0000-0000-0000-000000000004', 'ios', 'token-4', now() + interval '5 minutes');
SELECT count(*) FROM claim_game_start_deliveries('$GAME','$LEASE_A',45,1);
SELECT settle_game_start_delivery_batch(
  '[{"id":"00000000-0000-0000-0000-000000000004","status":"transient","error":"timeout"}]'::jsonb,
  '$LEASE_A'
);
SQL
IMMEDIATE_RETRY=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_game_start_deliveries('$GAME','$LEASE_C',45,1)")
[ "$IMMEDIATE_RETRY" = "0" ] || { echo "FAIL: transient retried immediately=$IMMEDIATE_RETRY" >&2; exit 1; }
"${PSQL[@]}" -c "UPDATE game_start_delivery_ledger SET next_attempt_at=now()-interval '1 second' WHERE id='00000000-0000-0000-0000-000000000004'" >/dev/null
NEXT_TICK_RETRY=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_game_start_deliveries('$GAME','$LEASE_C',45,1)")
[ "$NEXT_TICK_RETRY" = "1" ] || { echo "FAIL: transient missing next-tick retry=$NEXT_TICK_RETRY" >&2; exit 1; }

# highlight token barrier: same-team ON만 start accepted가 필요하다. OFF와 cross-team ON은 bypass,
# pending/permanent same-team token 하나가 다른 token release를 막지 않는다.
HIGHLIGHT_GAME=20260726KTLT0
"${PSQL[@]}" <<SQL >/dev/null
INSERT INTO profiles(id, team_id) VALUES
 ('10000000-0000-0000-0000-000000000010',1),
 ('10000000-0000-0000-0000-000000000011',1),
 ('10000000-0000-0000-0000-000000000012',1),
 ('10000000-0000-0000-0000-000000000013',9),
 ('10000000-0000-0000-0000-000000000014',1);
INSERT INTO notification_prefs(user_id, game_start, fav_player_highlight) VALUES
 ('10000000-0000-0000-0000-000000000010',true,true),
 ('10000000-0000-0000-0000-000000000011',true,true),
 ('10000000-0000-0000-0000-000000000012',false,true),
 ('10000000-0000-0000-0000-000000000013',true,true),
 ('10000000-0000-0000-0000-000000000014',true,true);
INSERT INTO device_push_tokens(id,user_id,platform,fcm_token) VALUES
 (10,'10000000-0000-0000-0000-000000000010','ios','accepted'),
 (11,'10000000-0000-0000-0000-000000000011','ios','pending'),
 (12,'10000000-0000-0000-0000-000000000012','ios','off'),
 (13,'10000000-0000-0000-0000-000000000013','ios','cross-team'),
 (14,'10000000-0000-0000-0000-000000000014','ios','invalid');
INSERT INTO game_start_delivery_ledger
 (game_id,token_id,token_hash,user_id,platform,fcm_token,status,deadline_at)
SELECT '$HIGHLIGHT_GAME',d.id,encode(extensions.digest(d.fcm_token,'sha256'),'hex'),
       d.user_id,d.platform,null,
       CASE d.id WHEN 10 THEN 'accepted' WHEN 14 THEN 'permanent_failed' ELSE 'pending' END,
       now()+interval '5 minutes'
FROM device_push_tokens d WHERE d.id IN (10,11,14);
SQL
RELEASED=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_player_highlight_tokens(
  'event#fav','$HIGHLIGHT_GAME',ARRAY[1,2]::integer[],
  ARRAY[
    '10000000-0000-0000-0000-000000000010',
    '10000000-0000-0000-0000-000000000011',
    '10000000-0000-0000-0000-000000000012',
    '10000000-0000-0000-0000-000000000013',
    '10000000-0000-0000-0000-000000000014'
  ]::uuid[],'fav_player_highlight',true,500)")
[ "$RELEASED" = "3" ] || { echo "FAIL: token barrier released=$RELEASED expected=3" >&2; exit 1; }
CLAIMED_IDS=$("${PSQL[@]}" -c "SELECT string_agg(token_id::text,',' ORDER BY token_id) FROM notified_player_highlight_tokens WHERE event_id='event#fav' AND status='claimed'")
[ "$CLAIMED_IDS" = "10,12,13" ] || { echo "FAIL: token barrier claimed=$CLAIMED_IDS" >&2; exit 1; }
WAITING_IDS=$("${PSQL[@]}" -c "SELECT string_agg(token_id::text,',' ORDER BY token_id) FROM notified_player_highlight_tokens WHERE event_id='event#fav' AND status='waiting'")
[ "$WAITING_IDS" = "11,14" ] || { echo "FAIL: token barrier waiting=$WAITING_IDS" >&2; exit 1; }

# 팬 0명 이벤트도 terminal snapshot을 만들고, 이후 팬이 생겨도 과거 알림을 snapshot하지 않는다.
EMPTY_FIRST=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_player_highlight_tokens(
  'empty#fav','$HIGHLIGHT_GAME',ARRAY[1,2]::integer[],ARRAY[]::uuid[],
  'fav_player_highlight',true,500)")
EMPTY_LATE=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_player_highlight_tokens(
  'empty#fav','$HIGHLIGHT_GAME',ARRAY[1,2]::integer[],
  ARRAY['10000000-0000-0000-0000-000000000010']::uuid[],
  'fav_player_highlight',true,500)")
[ "$EMPTY_FIRST" = "0" ] && [ "$EMPTY_LATE" = "0" ] || {
  echo "FAIL: empty audience freeze first=$EMPTY_FIRST late=$EMPTY_LATE" >&2
  exit 1
}

echo "PASS PG17 game-start ledger + token barrier: overlap 0, crash retry 1, post-accept reclaim 0, transient backoff 1, release 3, empty freeze 0"
