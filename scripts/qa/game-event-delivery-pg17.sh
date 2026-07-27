#!/usr/bin/env bash
# S2 Slice0 (삼순 2차 NO-GO #1/#2) — score/concede/inning-summary durable token 원장 통합 회귀.
# game_event_delivery 원장의 pref-freeze / accepted 미재발 / bucket checkpoint / transient backoff /
# deadline terminal / source-independent due를 실 Postgres에서 잠근다.
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
WORK="$(mktemp -d "$REVIEW_ROOT/game-event-ledger-pg17.XXXXXX")"
DATADIR="$WORK/data"
SOCKDIR="$WORK/sock"
mkdir -p "$SOCKDIR"
cleanup() {
  "$PGBIN/pg_ctl" -D "$DATADIR" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATADIR" -A trust -U qa --locale=C --encoding=UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATADIR" -o "-p 59331 -k $SOCKDIR -c listen_addresses=''" -w start >/dev/null
PSQL=("$PGBIN/psql" -h "$SOCKDIR" -p 59331 -U qa -d postgres -v ON_ERROR_STOP=1 -qtA)

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
CREATE TABLE notified_score_events (event_id text PRIMARY KEY, game_id text NOT NULL);
SQL
"${PSQL[@]}" -f "$MIGRATION" >/dev/null

# 멱등성: 같은 마이그레이션 2회 로드해도 에러 없어야 한다(create if not exists / create or replace).
"${PSQL[@]}" -f "$MIGRATION" >/dev/null

GAME=20260727LGHH0
# team 1 fans: A(pref none), B(score/concede/inning 모두 on), C(score off).
# device: A=android build 90(구), B=ios, C=android.
"${PSQL[@]}" <<SQL >/dev/null
INSERT INTO profiles(id,team_id) VALUES
 ('10000000-0000-0000-0000-0000000000a1',1),
 ('10000000-0000-0000-0000-0000000000a2',1),
 ('10000000-0000-0000-0000-0000000000a3',1);
INSERT INTO notification_prefs(user_id,my_team_score,my_team_concede,my_team_score_inning_summary) VALUES
 ('10000000-0000-0000-0000-0000000000a2',true,true,true),
 ('10000000-0000-0000-0000-0000000000a3',false,null,null);
INSERT INTO device_push_tokens(id,user_id,platform,app_build,fcm_token) VALUES
 (1,'10000000-0000-0000-0000-0000000000a1','android',90,'tok-a'),
 (2,'10000000-0000-0000-0000-0000000000a2','ios',null,'tok-b'),
 (3,'10000000-0000-0000-0000-0000000000a3','android',null,'tok-c');
SQL

L1=40000000-0000-0000-0000-000000000001
L2=40000000-0000-0000-0000-000000000002
L3=40000000-0000-0000-0000-000000000003

# ── #1 pref-freeze audience: score(default on) → A(null→on)+B, C(off) 제외 = 2 토큰 ──
SCORE_CLAIM=$("${PSQL[@]}" -c "SELECT string_agg(token_id::text,',' ORDER BY token_id) FROM claim_game_event_tokens(
  'ev1','$GAME','score',1,'my_team_score','t','b','/games/$GAME',now(),'$L1',20,500)")
[ "$SCORE_CLAIM" = "1,2" ] || { echo "FAIL: score pref-freeze claim=$SCORE_CLAIM expected=1,2" >&2; exit 1; }
# event-global marker도 함께 기록됐다(back-compat).
MARKER=$("${PSQL[@]}" -c "SELECT count(*) FROM notified_score_events WHERE event_id='ev1'")
[ "$MARKER" = "1" ] || { echo "FAIL: notified_score_events marker=$MARKER" >&2; exit 1; }

# ── #1 P0 fault: A accepted + B transient settle → 재claim은 B만(accepted 재발송 0) ──
"${PSQL[@]}" -c "SELECT settle_game_event_tokens('[
  {\"token_id\":1,\"token_hash\":\"$("${PSQL[@]}" -c "SELECT token_hash FROM notified_game_event_tokens WHERE event_id='ev1' AND token_id=1")\",\"status\":\"accepted\",\"error\":null},
  {\"token_id\":2,\"token_hash\":\"$("${PSQL[@]}" -c "SELECT token_hash FROM notified_game_event_tokens WHERE event_id='ev1' AND token_id=2")\",\"status\":\"transient\",\"error\":\"messaging/internal-error\"}
]'::jsonb,'$L1')" >/dev/null
# transient는 30초 backoff라 같은 tick 즉시 재소진되지 않는다.
IMMEDIATE=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_game_event_tokens('ev1','$GAME','score',1,'my_team_score','t','b','/games/$GAME',now(),'$L2',20,500)")
[ "$IMMEDIATE" = "0" ] || { echo "FAIL: transient retried immediately=$IMMEDIATE" >&2; exit 1; }
# next_attempt_at 전진 → 재claim은 transient B(2)만. accepted A(1)는 재발송 안 됨.
"${PSQL[@]}" -c "UPDATE notified_game_event_tokens SET next_attempt_at=now()-interval '1 second' WHERE event_id='ev1'" >/dev/null
RETRY=$("${PSQL[@]}" -c "SELECT string_agg(token_id::text,',' ORDER BY token_id) FROM claim_game_event_tokens('ev1','$GAME','score',1,'my_team_score','t','b','/games/$GAME',now(),'$L3',20,500)")
[ "$RETRY" = "2" ] || { echo "FAIL: accepted resend leak — retry=$RETRY expected=2" >&2; exit 1; }
ACC_STATE=$("${PSQL[@]}" -c "SELECT status FROM notified_game_event_tokens WHERE event_id='ev1' AND token_id=1")
[ "$ACC_STATE" = "accepted" ] || { echo "FAIL: accepted token mutated=$ACC_STATE" >&2; exit 1; }

# ── #2 P0 bucket checkpoint: bucket1(accepted) durable settle 뒤 crash → 재claim은 미settle만 ──
# 한 claim에 2 토큰 → bucket1 토큰만 settle(accepted), bucket2 토큰은 미settle(leased) 상태에서
# lease 만료(crash) → 재claim은 settled accepted를 0회 재발송하고 leased-expired만 회수.
CGAME=20260727KTSS0
CL1=41000000-0000-0000-0000-000000000001
CL2=41000000-0000-0000-0000-000000000002
"${PSQL[@]}" <<SQL >/dev/null
INSERT INTO profiles(id,team_id) VALUES
 ('10000000-0000-0000-0000-0000000000b1',5),
 ('10000000-0000-0000-0000-0000000000b2',5);
INSERT INTO device_push_tokens(id,user_id,platform,app_build,fcm_token) VALUES
 (11,'10000000-0000-0000-0000-0000000000b1','ios',null,'tok-b1'),
 (12,'10000000-0000-0000-0000-0000000000b2','ios',null,'tok-b2');
SQL
"${PSQL[@]}" -c "SELECT count(*) FROM claim_game_event_tokens('ev2','$CGAME','score',5,'my_team_score','t','b','/games/$CGAME',now(),'$CL1',20,500)" >/dev/null
# bucket1 = token 11만 accepted settle(같은 lease의 부분 settle) — 12는 leased로 남김(버킷 간 crash).
"${PSQL[@]}" -c "SELECT settle_game_event_tokens('[
  {\"token_id\":11,\"token_hash\":\"$("${PSQL[@]}" -c "SELECT token_hash FROM notified_game_event_tokens WHERE event_id='ev2' AND token_id=11")\",\"status\":\"accepted\",\"error\":null}
]'::jsonb,'$CL1')" >/dev/null
CP_11=$("${PSQL[@]}" -c "SELECT status FROM notified_game_event_tokens WHERE event_id='ev2' AND token_id=11")
CP_12=$("${PSQL[@]}" -c "SELECT status FROM notified_game_event_tokens WHERE event_id='ev2' AND token_id=12")
[ "$CP_11" = "accepted" ] && [ "$CP_12" = "leased" ] || { echo "FAIL: bucket checkpoint state 11=$CP_11 12=$CP_12" >&2; exit 1; }
# crash: bucket2 lease 만료. 재claim은 12만(11 accepted 재발송 0).
"${PSQL[@]}" -c "UPDATE notified_game_event_tokens SET lease_until=now()-interval '1 second' WHERE event_id='ev2' AND token_id=12" >/dev/null
CP_RETRY=$("${PSQL[@]}" -c "SELECT string_agg(token_id::text,',' ORDER BY token_id) FROM claim_game_event_tokens('ev2','$CGAME','score',5,'my_team_score','t','b','/games/$CGAME',now(),'$CL2',20,500)")
[ "$CP_RETRY" = "12" ] || { echo "FAIL: bucket checkpoint reclaim=$CP_RETRY expected=12(11 must not resend)" >&2; exit 1; }

# ── concede pref default off: B(concede on)만 1 토큰, A(null→off)/C 제외 ──
CONCEDE=$("${PSQL[@]}" -c "SELECT string_agg(token_id::text,',' ORDER BY token_id) FROM claim_game_event_tokens(
  'ev1-concede','$GAME','concede',1,'my_team_concede','t','b','/games/$GAME',now(),'42000000-0000-0000-0000-000000000001',20,500)")
[ "$CONCEDE" = "2" ] || { echo "FAIL: concede default-off freeze=$CONCEDE expected=2" >&2; exit 1; }

# ── inning-summary pref default off: B(inning on)만 1 토큰 ──
INNING=$("${PSQL[@]}" -c "SELECT string_agg(token_id::text,',' ORDER BY token_id) FROM claim_game_event_tokens(
  'ev1-summary','$GAME','inning-summary',1,'my_team_score_inning_summary','t','b','/games/$GAME',now(),'42000000-0000-0000-0000-000000000002',20,500)")
[ "$INNING" = "2" ] || { echo "FAIL: inning-summary default-off freeze=$INNING expected=2" >&2; exit 1; }

# ── deadline(= source_ts + 6h) 초과: 미종결 토큰 expired terminal, 반환 0 ──
DGAME=20260727NCKI0
"${PSQL[@]}" <<SQL >/dev/null
INSERT INTO profiles(id,team_id) VALUES ('10000000-0000-0000-0000-0000000000c1',7);
INSERT INTO device_push_tokens(id,user_id,platform,app_build,fcm_token) VALUES
 (21,'10000000-0000-0000-0000-0000000000c1','ios',null,'tok-c1');
SQL
DEADLINE_CLAIM=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_game_event_tokens(
  'ev-old','$DGAME','score',7,'my_team_score','t','b','/games/$DGAME',now()-interval '7 hours','43000000-0000-0000-0000-000000000001',20,500)")
[ "$DEADLINE_CLAIM" = "0" ] || { echo "FAIL: past-deadline claim released tokens=$DEADLINE_CLAIM" >&2; exit 1; }
DEADLINE_STATE=$("${PSQL[@]}" -c "SELECT status FROM notified_game_event_tokens WHERE event_id='ev-old' AND token_id=21")
[ "$DEADLINE_STATE" = "expired" ] || { echo "FAIL: past-deadline token state=$DEADLINE_STATE" >&2; exit 1; }

# ── audience freeze: 팬 0명 이벤트는 completed snapshot만, 이후 팬 추가돼도 catch-up 없음 ──
EGAME=20260727SKWO0
EMPTY_FIRST=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_game_event_tokens(
  'ev-empty','$EGAME','score',3,'my_team_score','t','b','/games/$EGAME',now(),'44000000-0000-0000-0000-000000000001',20,500)")
[ "$EMPTY_FIRST" = "0" ] || { echo "FAIL: empty audience claim=$EMPTY_FIRST" >&2; exit 1; }
"${PSQL[@]}" <<SQL >/dev/null
INSERT INTO profiles(id,team_id) VALUES ('10000000-0000-0000-0000-0000000000d1',3);
INSERT INTO device_push_tokens(id,user_id,platform,app_build,fcm_token) VALUES
 (31,'10000000-0000-0000-0000-0000000000d1','ios',null,'tok-d1');
SQL
EMPTY_LATE=$("${PSQL[@]}" -c "SELECT count(*) FROM claim_game_event_tokens(
  'ev-empty','$EGAME','score',3,'my_team_score','t','b','/games/$EGAME',now(),'44000000-0000-0000-0000-000000000002',20,500)")
[ "$EMPTY_LATE" = "0" ] || { echo "FAIL: late-fan catch-up leak=$EMPTY_LATE" >&2; exit 1; }
EMPTY_TOKENS=$("${PSQL[@]}" -c "SELECT count(*) FROM notified_game_event_tokens WHERE event_id='ev-empty'")
[ "$EMPTY_TOKENS" = "0" ] || { echo "FAIL: late-fan token inserted=$EMPTY_TOKENS" >&2; exit 1; }

# ── source-independent due: transient 토큰 남은 snapshot은 feed 없이도 due, deadline 뒤 제외 ──
# 앞 RETRY claim이 token2를 leased로 두었으니 transient로 settle해 due 상태로 되돌린다(feed 소멸 가정).
"${PSQL[@]}" -c "SELECT settle_game_event_tokens('[
  {\"token_id\":2,\"token_hash\":\"$("${PSQL[@]}" -c "SELECT token_hash FROM notified_game_event_tokens WHERE event_id='ev1' AND token_id=2")\",\"status\":\"transient\",\"error\":\"messaging/internal-error\"}
]'::jsonb,'$L3')" >/dev/null
"${PSQL[@]}" -c "UPDATE notified_game_event_tokens SET next_attempt_at=now()-interval '1 second' WHERE event_id='ev1' AND token_id=2" >/dev/null
DUE=$("${PSQL[@]}" -c "SELECT count(*) FROM list_due_game_event_snapshots(50) WHERE event_id='ev1'")
[ "$DUE" = "1" ] || { echo "FAIL: source-independent due for transient ev1=$DUE" >&2; exit 1; }
"${PSQL[@]}" -c "UPDATE game_event_delivery_snapshots SET deadline_at=now()-interval '1 second' WHERE event_id='ev1'" >/dev/null
DUE_AFTER=$("${PSQL[@]}" -c "SELECT count(*) FROM list_due_game_event_snapshots(50) WHERE event_id='ev1'")
[ "$DUE_AFTER" = "0" ] || { echo "FAIL: past-deadline still due=$DUE_AFTER" >&2; exit 1; }

echo "PASS PG17 game_event ledger: pref freeze, accepted-no-resend, bucket checkpoint, deadline terminal, source-independent due"
