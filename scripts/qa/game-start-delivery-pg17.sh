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
THROUGHPUT_MIGRATION="$ROOT/supabase/migrations/20260730_game_start_fanout_throughput.sql"
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
  fcm_token text NOT NULL,
  created_at timestamptz DEFAULT now(),
  last_seen timestamptz DEFAULT now()
);
CREATE TABLE notified_score_events (
  event_id text PRIMARY KEY,
  game_id text NOT NULL
);
SQL
"${PSQL[@]}" -f "$MIGRATION" >/dev/null
"${PSQL[@]}" -f "$THROUGHPUT_MIGRATION" >/dev/null

# 사용자별 최신 활성토큰을 구 토큰보다 먼저 claim하되, transient retry는 남은 pending 뒤다.
PRIORITY_GAME=20260730HHLG0
PRIORITY_LEASE=21000000-0000-0000-0000-000000000001
"${PSQL[@]}" <<SQL >/dev/null
INSERT INTO profiles(id, team_id) VALUES
 ('11000000-0000-0000-0000-000000000001',7),
 ('11000000-0000-0000-0000-000000000002',7);
INSERT INTO notification_prefs(user_id, game_start) VALUES
 ('11000000-0000-0000-0000-000000000001',true),
 ('11000000-0000-0000-0000-000000000002',true);
INSERT INTO device_push_tokens(id,user_id,platform,fcm_token,created_at,last_seen) VALUES
 (101,'11000000-0000-0000-0000-000000000001','ios','old-phone',now()-interval '30 days',now()-interval '30 days'),
 (102,'11000000-0000-0000-0000-000000000001','ios','latest-phone',now(),now()),
 (103,'11000000-0000-0000-0000-000000000002','android','only-phone',now(),now());
SELECT snapshot_game_start_deliveries('$PRIORITY_GAME',ARRAY[7],now(),now()+interval '5 minutes');
SELECT count(*) FROM claim_game_start_deliveries('$PRIORITY_GAME','$PRIORITY_LEASE',45,2);
SQL
PRIMARY_IDS=$("${PSQL[@]}" -c "SELECT string_agg(token_id::text,',' ORDER BY token_id) FROM game_start_delivery_ledger WHERE game_id='$PRIORITY_GAME' AND status='leased'")
[ "$PRIMARY_IDS" = "102,103" ] || {
  echo "FAIL: latest-token first claim=$PRIMARY_IDS expected=102,103" >&2
  exit 1
}
"${PSQL[@]}" <<SQL >/dev/null
SELECT settle_game_start_delivery_batch(
  (SELECT jsonb_agg(jsonb_build_object('id',id,'status','transient','error','timeout'))
     FROM game_start_delivery_ledger
    WHERE game_id='$PRIORITY_GAME' AND status='leased'),
  '$PRIORITY_LEASE'
);
UPDATE game_start_delivery_ledger
   SET next_attempt_at=now()-interval '1 second'
 WHERE game_id='$PRIORITY_GAME' AND status='transient';
SQL
PENDING_LEASE=21000000-0000-0000-0000-000000000002
PENDING_FIRST=$("${PSQL[@]}" -c "SELECT token_id FROM claim_game_start_deliveries('$PRIORITY_GAME','$PENDING_LEASE',45,1)")
[ "$PENDING_FIRST" = "101" ] || {
  echo "FAIL: pending old token must precede transient retry, got=$PENDING_FIRST" >&2
  exit 1
}

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

# 삼순 P1 회귀: 혼합 큐 우선순위 — pending → 만료 pre-dispatch leased(crash 미시도) → transient.
MIX_GAME=20260730SSNC0
"${PSQL[@]}" <<SQL >/dev/null
INSERT INTO game_notify_state(game_id, start_snapshot_at, start_snapshot_deadline_at)
VALUES ('$MIX_GAME', now(), now() + interval '5 minutes');
INSERT INTO game_start_delivery_ledger
  (id, game_id, token_id, token_hash, user_id, platform, fcm_token, deadline_at,
   status, attempts, lease_token, lease_until, dispatch_started_at, next_attempt_at)
VALUES
  ('00000000-0000-0000-0000-000000000021', '$MIX_GAME', 21, 'h21',
   '10000000-0000-0000-0000-000000000021', 'ios', 'token-21', now() + interval '5 minutes',
   'pending', 0, null, null, null, now() - interval '1 second'),
  ('00000000-0000-0000-0000-000000000022', '$MIX_GAME', 22, 'h22',
   '10000000-0000-0000-0000-000000000022', 'android', 'token-22', now() + interval '5 minutes',
   'leased', 1, '22000000-0000-0000-0000-000000000099', now() - interval '1 second', null, now() - interval '1 second'),
  ('00000000-0000-0000-0000-000000000023', '$MIX_GAME', 23, 'h23',
   '10000000-0000-0000-0000-000000000023', 'ios', 'token-23', now() + interval '5 minutes',
   'transient', 1, null, null, null, now() - interval '1 second');
SQL
MIX_LEASE=22000000-0000-0000-0000-000000000001
MIX_1=$("${PSQL[@]}" -c "SELECT token_id FROM claim_game_start_deliveries('$MIX_GAME','$MIX_LEASE',45,1)")
MIX_2=$("${PSQL[@]}" -c "SELECT token_id FROM claim_game_start_deliveries('$MIX_GAME','$MIX_LEASE',45,1)")
MIX_3=$("${PSQL[@]}" -c "SELECT token_id FROM claim_game_start_deliveries('$MIX_GAME','$MIX_LEASE',45,1)")
[ "$MIX_1" = "21" ] && [ "$MIX_2" = "22" ] && [ "$MIX_3" = "23" ] || {
  echo "FAIL: mixed queue priority expected 21(pending)->22(expired leased)->23(transient), got=$MIX_1,$MIX_2,$MIX_3" >&2
  exit 1
}

# 삼순 P1 회귀: due transient 500행이 batch 상한을 가득 채워도 미시도 crash(만료 pre-dispatch leased) 행이
# 같은 batch에서 먼저 claim되어 deadline 안에 send를 시작한다(구 정렬이면 crash 행이 batch에서 밀려 RED).
STARVE_GAME=20260730WOKT0
"${PSQL[@]}" <<SQL >/dev/null
INSERT INTO game_notify_state(game_id, start_snapshot_at, start_snapshot_deadline_at)
VALUES ('$STARVE_GAME', now(), now() + interval '90 seconds');
INSERT INTO game_start_delivery_ledger
  (id, game_id, token_id, token_hash, user_id, platform, fcm_token, deadline_at,
   status, attempts, next_attempt_at)
SELECT
  ('00000000-0000-0000-0001-'||lpad(n::text,12,'0'))::uuid, '$STARVE_GAME', 1000+n, 'sh'||n,
  '10000000-0000-0000-0000-000000000031', 'android', 'starve-token-'||n, now() + interval '90 seconds',
  'transient', 1, now() - interval '1 second'
FROM generate_series(1,500) n;
INSERT INTO game_start_delivery_ledger
  (id, game_id, token_id, token_hash, user_id, platform, fcm_token, deadline_at,
   status, attempts, lease_token, lease_until, dispatch_started_at, next_attempt_at)
VALUES
  ('00000000-0000-0000-0000-000000000031', '$STARVE_GAME', 31, 'h31',
   '10000000-0000-0000-0000-000000000031', 'ios', 'crash-token-31', now() + interval '90 seconds',
   'leased', 1, '23000000-0000-0000-0000-000000000099', now() - interval '1 second', null, now() - interval '1 second');
SQL
STARVE_LEASE=23000000-0000-0000-0000-000000000001
STARVE_CRASH_CLAIMED=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_game_start_deliveries('$STARVE_GAME','$STARVE_LEASE',45,500) WHERE token_id=31")
[ "$STARVE_CRASH_CLAIMED" = "1" ] || {
  echo "FAIL: untried crash row starved out of full 500-transient batch (claimed=$STARVE_CRASH_CLAIMED)" >&2
  exit 1
}
STARVE_CRASH_STATE=$("${PSQL[@]}" -c "SELECT status||':'||attempts||':'||lease_token FROM game_start_delivery_ledger WHERE token_id=31 AND game_id='$STARVE_GAME'")
[ "$STARVE_CRASH_STATE" = "leased:2:$STARVE_LEASE" ] || {
  echo "FAIL: crash row post-claim state=$STARVE_CRASH_STATE" >&2
  exit 1
}

# highlight token barrier: same-team ON만 start accepted가 필요하다. OFF와 cross-team ON은 bypass,
# pending/permanent same-team token 하나가 다른 token release를 막지 않는다.
HIGHLIGHT_GAME=20260726KTLT0
"${PSQL[@]}" <<SQL >/dev/null
INSERT INTO profiles(id, team_id) VALUES
 ('10000000-0000-0000-0000-000000000010',1),
 ('10000000-0000-0000-0000-000000000011',1),
 ('10000000-0000-0000-0000-000000000012',1),
 ('10000000-0000-0000-0000-000000000013',9),
 ('10000000-0000-0000-0000-000000000014',1),
 ('10000000-0000-0000-0000-000000000015',1);
INSERT INTO notification_prefs(user_id, game_start, fav_player_highlight) VALUES
 ('10000000-0000-0000-0000-000000000010',true,true),
 ('10000000-0000-0000-0000-000000000011',true,true),
 ('10000000-0000-0000-0000-000000000012',false,true),
 ('10000000-0000-0000-0000-000000000013',true,true),
 ('10000000-0000-0000-0000-000000000014',true,true),
 ('10000000-0000-0000-0000-000000000015',true,true);
INSERT INTO device_push_tokens(id,user_id,platform,fcm_token) VALUES
 (10,'10000000-0000-0000-0000-000000000010','ios','accepted'),
 (11,'10000000-0000-0000-0000-000000000011','ios','pending'),
 (12,'10000000-0000-0000-0000-000000000012','ios','off'),
 (13,'10000000-0000-0000-0000-000000000013','ios','cross-team'),
 (14,'10000000-0000-0000-0000-000000000014','ios','invalid'),
 (15,'10000000-0000-0000-0000-000000000015','ios','same-tick');
INSERT INTO game_start_delivery_ledger
 (game_id,token_id,token_hash,user_id,platform,fcm_token,status,deadline_at,fcm_accepted_at)
SELECT '$HIGHLIGHT_GAME',d.id,encode(extensions.digest(d.fcm_token,'sha256'),'hex'),
       d.user_id,d.platform,null,
       CASE d.id WHEN 10 THEN 'accepted' WHEN 15 THEN 'accepted' WHEN 14 THEN 'permanent_failed' ELSE 'pending' END,
       now()+interval '5 minutes',
       CASE d.id WHEN 10 THEN now()-interval '2 minutes' WHEN 15 THEN now() ELSE null END
FROM device_push_tokens d WHERE d.id IN (10,11,14,15);
SQL
HIGHLIGHT_LEASE=30000000-0000-0000-0000-000000000001
RELEASED=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_player_highlight_tokens(
  'event#fav','$HIGHLIGHT_GAME',ARRAY[1,2]::integer[],
  ARRAY[
    '10000000-0000-0000-0000-000000000010',
    '10000000-0000-0000-0000-000000000011',
    '10000000-0000-0000-0000-000000000012',
    '10000000-0000-0000-0000-000000000013',
    '10000000-0000-0000-0000-000000000014',
    '10000000-0000-0000-0000-000000000015'
  ]::uuid[],'fav_player_highlight',true,now()-interval '10 seconds',
  '$HIGHLIGHT_LEASE',20,500)")
[ "$RELEASED" = "3" ] || { echo "FAIL: token barrier released=$RELEASED expected=3" >&2; exit 1; }
LEASED_IDS=$("${PSQL[@]}" -c "SELECT string_agg(token_id::text,',' ORDER BY token_id) FROM notified_player_highlight_tokens WHERE event_id='event#fav' AND status='leased'")
[ "$LEASED_IDS" = "10,12,13" ] || { echo "FAIL: token barrier leased=$LEASED_IDS" >&2; exit 1; }
WAITING_IDS=$("${PSQL[@]}" -c "SELECT string_agg(token_id::text,',' ORDER BY token_id) FROM notified_player_highlight_tokens WHERE event_id='event#fav' AND status='waiting'")
[ "$WAITING_IDS" = "11,14,15" ] || { echo "FAIL: token barrier waiting=$WAITING_IDS" >&2; exit 1; }

# token별 FCM 결과 settle: accepted/permanent는 terminal, transient만 45초 backoff 후 재시도.
"${PSQL[@]}" <<SQL >/dev/null
SELECT settle_player_highlight_tokens(
  jsonb_agg(jsonb_build_object(
    'token_id',token_id,
    'token_hash',token_hash,
    'status',case token_id when 10 then 'accepted' when 12 then 'transient' else 'permanent_failed' end,
    'error',case token_id when 12 then 'messaging/server-unavailable' else null end
  )),
  '$HIGHLIGHT_LEASE'
)
FROM notified_player_highlight_tokens
WHERE event_id='event#fav' AND status='leased';
SQL
SETTLED=$("${PSQL[@]}" -c "SELECT string_agg(token_id||':'||status,',' ORDER BY token_id) FROM notified_player_highlight_tokens WHERE event_id='event#fav' AND token_id IN (10,12,13)")
[ "$SETTLED" = "10:accepted,12:transient,13:permanent_failed" ] || { echo "FAIL: highlight settle=$SETTLED" >&2; exit 1; }
HIGHLIGHT_RETRY_LEASE=30000000-0000-0000-0000-000000000002
HIGHLIGHT_IMMEDIATE=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_player_highlight_tokens(
  'event#fav','$HIGHLIGHT_GAME',ARRAY[1,2]::integer[],ARRAY[]::uuid[],
  'fav_player_highlight',true,now()-interval '10 seconds','$HIGHLIGHT_RETRY_LEASE',20,500)")
[ "$HIGHLIGHT_IMMEDIATE" = "0" ] || { echo "FAIL: highlight transient retried immediately=$HIGHLIGHT_IMMEDIATE" >&2; exit 1; }
"${PSQL[@]}" -c "UPDATE notified_player_highlight_tokens SET next_attempt_at=now()-interval '1 second' WHERE event_id='event#fav' AND token_id=12" >/dev/null
HIGHLIGHT_RETRY=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_player_highlight_tokens(
  'event#fav','$HIGHLIGHT_GAME',ARRAY[1,2]::integer[],ARRAY[]::uuid[],
  'fav_player_highlight',true,now()-interval '10 seconds','$HIGHLIGHT_RETRY_LEASE',20,500)")
[ "$HIGHLIGHT_RETRY" = "1" ] || { echo "FAIL: highlight transient missing retry=$HIGHLIGHT_RETRY" >&2; exit 1; }

# 3회 연속 transient도 permanent로 오분류하지 않고 snapshot deadline까지 재시도한다.
"${PSQL[@]}" -c "SELECT settle_player_highlight_tokens(
  jsonb_build_array(jsonb_build_object(
    'token_id',12,
    'token_hash',(SELECT token_hash FROM notified_player_highlight_tokens WHERE event_id='event#fav' AND token_id=12),
    'status','transient',
    'error','messaging/server-unavailable'
  )),
  '$HIGHLIGHT_RETRY_LEASE'
)" >/dev/null
"${PSQL[@]}" -c "UPDATE notified_player_highlight_tokens SET next_attempt_at=now()-interval '1 second' WHERE event_id='event#fav' AND token_id=12" >/dev/null
HIGHLIGHT_THIRD_LEASE=30000000-0000-0000-0000-000000000005
THIRD_CLAIM=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_player_highlight_tokens(
  'event#fav','$HIGHLIGHT_GAME',ARRAY[1,2]::integer[],ARRAY[]::uuid[],
  'fav_player_highlight',true,now()-interval '10 seconds','$HIGHLIGHT_THIRD_LEASE',20,500)")
[ "$THIRD_CLAIM" = "1" ] || { echo "FAIL: third transient claim=$THIRD_CLAIM" >&2; exit 1; }
"${PSQL[@]}" -c "SELECT settle_player_highlight_tokens(
  jsonb_build_array(jsonb_build_object(
    'token_id',12,
    'token_hash',(SELECT token_hash FROM notified_player_highlight_tokens WHERE event_id='event#fav' AND token_id=12),
    'status','transient',
    'error','messaging/server-unavailable'
  )),
  '$HIGHLIGHT_THIRD_LEASE'
)" >/dev/null
THIRD_STATE=$("${PSQL[@]}" -c "SELECT status||':'||attempts FROM notified_player_highlight_tokens WHERE event_id='event#fav' AND token_id=12")
[ "$THIRD_STATE" = "transient:3" ] || { echo "FAIL: third transient state=$THIRD_STATE" >&2; exit 1; }

# 세 번째 pre-send crash도 lease 만료 뒤 deadline 안에서 reclaim된다(attempt cap 없음).
"${PSQL[@]}" -c "UPDATE notified_player_highlight_tokens SET attempts=2, next_attempt_at=now()-interval '1 second' WHERE event_id='event#fav' AND token_id=15" >/dev/null
HIGHLIGHT_CRASH_LEASE=30000000-0000-0000-0000-000000000006
THIRD_CRASH=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_player_highlight_tokens(
  'event#fav','$HIGHLIGHT_GAME',ARRAY[1,2]::integer[],ARRAY[]::uuid[],
  'fav_player_highlight',true,now()+interval '2 minutes','$HIGHLIGHT_CRASH_LEASE',20,500)")
[ "$THIRD_CRASH" = "1" ] || { echo "FAIL: third-attempt crash setup=$THIRD_CRASH" >&2; exit 1; }
"${PSQL[@]}" -c "UPDATE notified_player_highlight_tokens SET lease_until=now()-interval '1 second' WHERE event_id='event#fav' AND token_id=15" >/dev/null
HIGHLIGHT_RECOVER_LEASE=30000000-0000-0000-0000-000000000007
CRASH_RECOVERED=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_player_highlight_tokens(
  'event#fav','$HIGHLIGHT_GAME',ARRAY[1,2]::integer[],ARRAY[]::uuid[],
  'fav_player_highlight',true,now()+interval '2 minutes','$HIGHLIGHT_RECOVER_LEASE',20,500)")
[ "$CRASH_RECOVERED" = "1" ] || { echo "FAIL: third-attempt crash recovery=$CRASH_RECOVERED" >&2; exit 1; }

# snapshot deadline을 넘긴 미종결 row는 leased/transient로 고착되지 않고 expired terminal.
"${PSQL[@]}" -c "UPDATE player_highlight_event_snapshots SET deadline_at=now()-interval '1 second' WHERE event_id='event#fav'" >/dev/null
DEADLINE_CLAIM=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_player_highlight_tokens(
  'event#fav','$HIGHLIGHT_GAME',ARRAY[1,2]::integer[],ARRAY[]::uuid[],
  'fav_player_highlight',true,now()+interval '2 minutes','30000000-0000-0000-0000-000000000008',20,500)")
[ "$DEADLINE_CLAIM" = "0" ] || { echo "FAIL: highlight deadline claim=$DEADLINE_CLAIM" >&2; exit 1; }
DEADLINE_STATES=$("${PSQL[@]}" -c "SELECT count(*) FROM notified_player_highlight_tokens WHERE event_id='event#fav' AND status='expired'")
[ "$DEADLINE_STATES" = "4" ] || { echo "FAIL: highlight deadline expired=$DEADLINE_STATES expected=4" >&2; exit 1; }

# 팬 0명 이벤트도 terminal snapshot을 만들고, 이후 팬이 생겨도 과거 알림을 snapshot하지 않는다.
EMPTY_FIRST=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_player_highlight_tokens(
  'empty#fav','$HIGHLIGHT_GAME',ARRAY[1,2]::integer[],ARRAY[]::uuid[],
  'fav_player_highlight',true,now(),'30000000-0000-0000-0000-000000000003',20,500)")
EMPTY_LATE=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_player_highlight_tokens(
  'empty#fav','$HIGHLIGHT_GAME',ARRAY[1,2]::integer[],
  ARRAY['10000000-0000-0000-0000-000000000010']::uuid[],
  'fav_player_highlight',true,now(),'30000000-0000-0000-0000-000000000004',20,500)")
[ "$EMPTY_FIRST" = "0" ] && [ "$EMPTY_LATE" = "0" ] || {
  echo "FAIL: empty audience freeze first=$EMPTY_FIRST late=$EMPTY_LATE" >&2
  exit 1
}

# 부분 snapshot crash 상태도 player_id로 원래 audience를 전량 재열거해 누락 없이 완료한다.
"${PSQL[@]}" <<SQL >/dev/null
INSERT INTO player_highlight_event_snapshots
  (event_id,game_id,player_id,pref_key,start_team_ids,push_title,push_body,push_url,
   snapshot_completed,deadline_at)
VALUES
  ('partial#fav','$HIGHLIGHT_GAME','12345','fav_player_highlight',ARRAY[1,2],
   'title','body','/games/$HIGHLIGHT_GAME',false,now()+interval '30 minutes');
INSERT INTO notified_player_highlight_tokens
  (event_id,game_id,token_id,token_hash,start_required)
SELECT 'partial#fav','$HIGHLIGHT_GAME',d.id,
       encode(extensions.digest(d.fcm_token,'sha256'),'hex'),true
FROM device_push_tokens d WHERE d.id=10;
SELECT count(*) FROM claim_player_highlight_tokens(
  p_event_id=>'partial#fav',
  p_game_id=>'$HIGHLIGHT_GAME',
  p_start_team_ids=>ARRAY[1,2]::integer[],
  p_user_ids=>ARRAY[
    '10000000-0000-0000-0000-000000000010',
    '10000000-0000-0000-0000-000000000011'
  ]::uuid[],
  p_pref_key=>'fav_player_highlight',
  p_finalize_snapshot=>true,
  p_start_accepted_before=>date_trunc('minute',now())+interval '1 minute',
  p_lease_token=>'30000000-0000-0000-0000-000000000009',
  p_player_id=>'12345',
  p_push_title=>'title',
  p_push_body=>'body',
  p_push_url=>'/games/$HIGHLIGHT_GAME'
);
SQL
PARTIAL_RESUMED=$("${PSQL[@]}" -c "SELECT snapshot_completed::text||':'||(
  SELECT string_agg(token_id::text,',' ORDER BY token_id)
  FROM notified_player_highlight_tokens n WHERE n.event_id=s.event_id
) FROM player_highlight_event_snapshots s WHERE event_id='partial#fav'")
[ "$PARTIAL_RESUMED" = "true:10,11" ] || {
  echo "FAIL: partial snapshot resume=$PARTIAL_RESUMED" >&2
  exit 1
}

# start accepted는 nominal minute bucket을 넘어야 release된다: 같은 minute overlap 0, 다음 minute 1.
"${PSQL[@]}" -c "UPDATE game_start_delivery_ledger
  SET fcm_accepted_at=date_trunc('minute',now())+interval '5 seconds'
  WHERE game_id='$HIGHLIGHT_GAME' AND token_id=15" >/dev/null
SAME_MINUTE=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_player_highlight_tokens(
  p_event_id=>'tick#fav',
  p_game_id=>'$HIGHLIGHT_GAME',
  p_start_team_ids=>ARRAY[1,2]::integer[],
  p_user_ids=>ARRAY['10000000-0000-0000-0000-000000000015']::uuid[],
  p_pref_key=>'fav_player_highlight',
  p_finalize_snapshot=>true,
  p_start_accepted_before=>date_trunc('minute',now()),
  p_lease_token=>'30000000-0000-0000-0000-000000000010',
  p_player_id=>'12345',
  p_push_title=>'title',
  p_push_body=>'body',
  p_push_url=>'/games/$HIGHLIGHT_GAME'
)")
NEXT_MINUTE=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_player_highlight_tokens(
  p_event_id=>'tick#fav',
  p_game_id=>'$HIGHLIGHT_GAME',
  p_start_team_ids=>ARRAY[1,2]::integer[],
  p_user_ids=>ARRAY[]::uuid[],
  p_pref_key=>'fav_player_highlight',
  p_finalize_snapshot=>true,
  p_start_accepted_before=>date_trunc('minute',now())+interval '1 minute',
  p_lease_token=>'30000000-0000-0000-0000-000000000011',
  p_player_id=>'12345',
  p_push_title=>'title',
  p_push_body=>'body',
  p_push_url=>'/games/$HIGHLIGHT_GAME'
)")
[ "$SAME_MINUTE" = "0" ] && [ "$NEXT_MINUTE" = "1" ] || {
  echo "FAIL: tick bucket same=$SAME_MINUTE next=$NEXT_MINUTE" >&2
  exit 1
}

# source event/game이 사라져도 due snapshot은 durable payload로 조회되고 deadline 뒤 expired 처리된다.
"${PSQL[@]}" <<SQL >/dev/null
INSERT INTO player_highlight_event_snapshots
  (event_id,game_id,player_id,pref_key,start_team_ids,push_title,push_body,push_url,
   snapshot_completed,deadline_at,completed_at)
VALUES
  ('final#fav','$HIGHLIGHT_GAME','12345','fav_player_highlight',ARRAY[1,2],
   'final title','final body','/games/$HIGHLIGHT_GAME',true,now()+interval '30 minutes',now());
INSERT INTO notified_player_highlight_tokens
  (event_id,game_id,token_id,token_hash,start_required,status,next_attempt_at)
SELECT 'final#fav','$HIGHLIGHT_GAME',d.id,
       encode(extensions.digest(d.fcm_token,'sha256'),'hex'),false,'transient',now()-interval '1 second'
FROM device_push_tokens d WHERE d.id=12;
SQL
FINAL_DUE=$("${PSQL[@]}" -c "SELECT count(*) FROM list_due_player_highlight_snapshots(50) WHERE event_id='final#fav'")
[ "$FINAL_DUE" = "1" ] || { echo "FAIL: final source-independent due=$FINAL_DUE" >&2; exit 1; }
"${PSQL[@]}" -c "UPDATE player_highlight_event_snapshots SET deadline_at=now()-interval '1 second' WHERE event_id='final#fav'" >/dev/null
"${PSQL[@]}" -c "SELECT count(*) FROM list_due_player_highlight_snapshots(50)" >/dev/null
FINAL_EXPIRED=$("${PSQL[@]}" -c "SELECT status FROM notified_player_highlight_tokens WHERE event_id='final#fav'")
[ "$FINAL_EXPIRED" = "expired" ] || { echo "FAIL: final deadline state=$FINAL_EXPIRED" >&2; exit 1; }

# start-blocked oldest 50개가 뒤의 source-independent 발송 가능 snapshot을 가리지 않는다.
"${PSQL[@]}" <<SQL >/dev/null
INSERT INTO player_highlight_event_snapshots
  (event_id,game_id,player_id,pref_key,start_team_ids,push_title,push_body,push_url,
   snapshot_completed,deadline_at,completed_at,created_at)
SELECT
  'blocked-'||lpad(n::text,2,'0'),'$HIGHLIGHT_GAME','12345','fav_player_highlight',
  ARRAY[1,2],'blocked','blocked','/games/$HIGHLIGHT_GAME',
  true,now()+interval '30 minutes',now(),now()-interval '20 minutes'
FROM generate_series(1,50) n;
INSERT INTO notified_player_highlight_tokens
  (event_id,game_id,token_id,token_hash,start_required,status,next_attempt_at)
SELECT s.event_id,'$HIGHLIGHT_GAME',11,
       encode(extensions.digest('pending','sha256'),'hex'),true,'waiting',now()
FROM player_highlight_event_snapshots s
WHERE s.event_id LIKE 'blocked-%';

INSERT INTO player_highlight_event_snapshots
  (event_id,game_id,player_id,pref_key,start_team_ids,push_title,push_body,push_url,
   snapshot_completed,deadline_at,completed_at,created_at)
VALUES
  ('eligible-51#fav','$HIGHLIGHT_GAME','12345','fav_player_highlight',ARRAY[1,2],
   'eligible','eligible','/games/$HIGHLIGHT_GAME',
   true,now()+interval '5 seconds',now(),now());
INSERT INTO notified_player_highlight_tokens
  (event_id,game_id,token_id,token_hash,start_required,status,next_attempt_at)
VALUES
  ('eligible-51#fav','$HIGHLIGHT_GAME',12,
   encode(extensions.digest('off','sha256'),'hex'),false,'waiting',now());
SQL
FAIR_DUE=$("${PSQL[@]}" -c "SELECT count(*) FROM list_due_player_highlight_snapshots(50) WHERE event_id='eligible-51#fav'")
[ "$FAIR_DUE" = "1" ] || { echo "FAIL: blocked 50 starved eligible snapshot=$FAIR_DUE" >&2; exit 1; }
FAIR_CLAIM=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_player_highlight_tokens(
  'eligible-51#fav','$HIGHLIGHT_GAME',ARRAY[1,2]::integer[],ARRAY[]::uuid[],
  'fav_player_highlight',true,date_trunc('minute',now()),
  '30000000-0000-0000-0000-000000000012',20,500)")
[ "$FAIR_CLAIM" = "1" ] || { echo "FAIL: eligible 51st snapshot claim=$FAIR_CLAIM" >&2; exit 1; }

# audience timeout incomplete 50개도 durable attempt rotation 뒤 51번째 recovery를 가리지 않는다.
"${PSQL[@]}" <<SQL >/dev/null
INSERT INTO player_highlight_event_snapshots
  (event_id,game_id,player_id,pref_key,start_team_ids,push_title,push_body,push_url,
   snapshot_completed,deadline_at,created_at)
SELECT
  'incomplete-'||lpad(n::text,2,'0'),'$HIGHLIGHT_GAME','12345','fav_player_highlight',
  ARRAY[1,2],'incomplete','incomplete','/games/$HIGHLIGHT_GAME',
  false,now()+interval '30 minutes',now()-interval '10 minutes'
FROM generate_series(1,51) n;
SQL
INCOMPLETE_FIRST=$("${PSQL[@]}" -c "SELECT count(*) FROM list_due_player_highlight_snapshots(50) WHERE event_id LIKE 'incomplete-%'")
INCOMPLETE_51=$("${PSQL[@]}" -c "SELECT count(*) FROM list_due_player_highlight_snapshots(50) WHERE event_id='incomplete-51'")
[ "$INCOMPLETE_FIRST" = "50" ] && [ "$INCOMPLETE_51" = "1" ] || {
  echo "FAIL: incomplete round-robin first=$INCOMPLETE_FIRST recoverable51=$INCOMPLETE_51" >&2
  exit 1
}

echo "PASS PG17 start/highlight ledgers: fair due drain, bounded source-independent retries, token fences"
