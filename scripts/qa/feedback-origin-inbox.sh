#!/usr/bin/env bash
# 건의함(피드백) 회신 대화의 운영팀 쪽지함 노출 통합 회귀.
#
# 임시 로컬 Postgres 클러스터를 띄워 migration 20260725_feedback_origin_inbox.sql 를
# 실제로 적용한 뒤 admin_dm_inbox_page RPC 의 수신 자격 판정을 검증한다:
#   1) origin 컬럼 기본값 'dm' + CHECK 제약(dm/feedback 만 허용)
#   2) origin='feedback' + 운영팀 발신만 있는 대화 → 수신함 노출 (user_msg_count=0)  ← 핵심 blocker
#   3) origin='dm'  + 운영팀 발신만 있는 대화(broadcast) → 수신함 미노출
#   4) origin='dm'  + 유저 발신 1건+ 대화 → 기존대로 노출 (회귀 방지)
#   5) origin='feedback' + 유저가 나중에 답장 → 노출 + unread_count 정확
#   6) 정렬(last_message_at DESC, id DESC) 유지
#   7) 클라 롤(anon/authenticated) EXECUTE 차단, service_role 만 허용
# supabase local 없이도 도는 순수 pg 통합 테스트.
#
# 요구: PostgreSQL 17 (PATH 또는 /opt/homebrew/opt/postgresql@17/bin)
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

MIGRATION="$(cd "$(dirname "$0")/../.." && pwd)/supabase/migrations/20260725_feedback_origin_inbox.sql"
[ -f "$MIGRATION" ] || { echo "migration not found: $MIGRATION" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/feedback-inbox-qa.XXXXXX")"
DATADIR="$WORK/data"
SOCKDIR="$WORK/sock"
mkdir -p "$SOCKDIR"
cleanup() {
  "$PGBIN/pg_ctl" -D "$DATADIR" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATADIR" -A trust -U qa --locale=C --encoding=UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATADIR" -o "-p 59323 -k $SOCKDIR -c listen_addresses=''" -w start >/dev/null

PSQL=("$PGBIN/psql" -h "$SOCKDIR" -p 59323 -U qa -d postgres -v ON_ERROR_STOP=1 -qtA)

# 프로덕션과 동일한 최소 의존 스키마 + 클라 롤.
"${PSQL[@]}" <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE TABLE profiles (
  id UUID PRIMARY KEY,
  nickname TEXT,
  team_id INT
);
CREATE TABLE dm_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user1_id UUID NOT NULL,
  user2_id UUID NOT NULL,
  last_message TEXT,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE dm_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES dm_conversations(id),
  sender_id UUID NOT NULL,
  content TEXT,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 시스템(운영팀) 유저 + 대상 유저 4명
INSERT INTO profiles(id, nickname, team_id) VALUES
  ('00000000-0000-0000-0000-000000000001', '운영팀', NULL),
  ('11111111-1111-1111-1111-111111111111', '유저A', 1),
  ('22222222-2222-2222-2222-222222222222', '유저B', 2),
  ('33333333-3333-3333-3333-333333333333', '유저C', 3),
  ('44444444-4444-4444-4444-444444444444', '유저D', 4);
SQL

# migration 적용 (origin 컬럼 추가 + admin_dm_inbox_page 재생성)
"${PSQL[@]}" -f "$MIGRATION" >/dev/null

SYS='00000000-0000-0000-0000-000000000001'
UA='11111111-1111-1111-1111-111111111111'
UB='22222222-2222-2222-2222-222222222222'
UC='33333333-3333-3333-3333-333333333333'
UD='44444444-4444-4444-4444-444444444444'

pass=0; fail=0
check() { # name actual expected
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✅ $1"
  else fail=$((fail+1)); echo "  ❌ $1 (got: $2 / want: $3)"; fi
}

echo "[origin 컬럼 기본값 + CHECK 제약]"
# 기본값 'dm'
"${PSQL[@]}" -c "INSERT INTO dm_conversations(id,user1_id,user2_id) VALUES ('aaaaaaaa-0000-0000-0000-000000000001','$SYS','$UA')" >/dev/null
R=$("${PSQL[@]}" -c "SELECT origin FROM dm_conversations WHERE id='aaaaaaaa-0000-0000-0000-000000000001'")
check "origin 미지정 시 기본 'dm'" "$R" "dm"
# CHECK 제약: 잘못된 origin 거부 (if 구문으로 set -e/pipefail 회피)
if "${PSQL[@]}" -c "INSERT INTO dm_conversations(user1_id,user2_id,origin) VALUES ('$SYS','$UB','garbage')" >/dev/null 2>"$WORK/err.txt"; then
  check "잘못된 origin CHECK 거부" "inserted" "denied"
elif grep -q "dm_conversations_origin_check" "$WORK/err.txt"; then
  check "잘못된 origin CHECK 거부" "denied" "denied"
else
  check "잘못된 origin CHECK 거부" "other-error" "denied"
fi

# 테스트 데이터 리셋(위 삽입 제거)
"${PSQL[@]}" -c "DELETE FROM dm_conversations WHERE id='aaaaaaaa-0000-0000-0000-000000000001'" >/dev/null

echo ""
echo "[수신 자격 판정 — 4개 대화 시나리오]"
# Conv A: origin='feedback', 운영팀 발신만 (건의함 회신, 유저 미답장) → 노출되어야 함 (핵심 blocker)
"${PSQL[@]}" <<SQL >/dev/null
INSERT INTO dm_conversations(id,user1_id,user2_id,last_message,last_message_at,origin)
  VALUES ('a0000000-0000-0000-0000-00000000000a','$SYS','$UA','건의함 회신입니다','2026-07-25T01:00:00Z','feedback');
INSERT INTO dm_messages(conversation_id,sender_id,content) VALUES
  ('a0000000-0000-0000-0000-00000000000a','$SYS','건의함 회신입니다');
SQL

# Conv B: origin='dm', 운영팀 발신만 (broadcast 선발신) → 미노출
"${PSQL[@]}" <<SQL >/dev/null
INSERT INTO dm_conversations(id,user1_id,user2_id,last_message,last_message_at,origin)
  VALUES ('b0000000-0000-0000-0000-00000000000b','$SYS','$UB','공지 브로드캐스트','2026-07-25T02:00:00Z','dm');
INSERT INTO dm_messages(conversation_id,sender_id,content) VALUES
  ('b0000000-0000-0000-0000-00000000000b','$SYS','공지 브로드캐스트');
SQL

# Conv C: origin='dm', 유저 발신 1건+ (일반 DM) → 노출 (회귀)
"${PSQL[@]}" <<SQL >/dev/null
INSERT INTO dm_conversations(id,user1_id,user2_id,last_message,last_message_at,origin)
  VALUES ('c0000000-0000-0000-0000-00000000000c','$SYS','$UC','유저 문의','2026-07-25T03:00:00Z','dm');
INSERT INTO dm_messages(conversation_id,sender_id,content,is_read) VALUES
  ('c0000000-0000-0000-0000-00000000000c','$UC','유저 문의', false);
SQL

# Conv D: origin='feedback' + 유저가 나중에 답장(unread 1) → 노출 + unread=1
"${PSQL[@]}" <<SQL >/dev/null
INSERT INTO dm_conversations(id,user1_id,user2_id,last_message,last_message_at,origin)
  VALUES ('d0000000-0000-0000-0000-00000000000d','$SYS','$UD','유저 답장','2026-07-25T04:00:00Z','feedback');
INSERT INTO dm_messages(conversation_id,sender_id,content,is_read) VALUES
  ('d0000000-0000-0000-0000-00000000000d','$SYS','건의함 회신', true),
  ('d0000000-0000-0000-0000-00000000000d','$UD','유저 답장', false);
SQL

INBOX="SELECT id FROM admin_dm_inbox_page('$SYS'::uuid, NULL, NULL, 51)"

APPEARS_A=$("${PSQL[@]}" -c "SELECT count(*) FROM ($INBOX) t WHERE id='a0000000-0000-0000-0000-00000000000a'")
check "Conv A (feedback, 운영팀 발신만) 노출" "$APPEARS_A" "1"

APPEARS_B=$("${PSQL[@]}" -c "SELECT count(*) FROM ($INBOX) t WHERE id='b0000000-0000-0000-0000-00000000000b'")
check "Conv B (dm broadcast, 운영팀 발신만) 미노출" "$APPEARS_B" "0"

APPEARS_C=$("${PSQL[@]}" -c "SELECT count(*) FROM ($INBOX) t WHERE id='c0000000-0000-0000-0000-00000000000c'")
check "Conv C (dm, 유저 발신 1건+) 노출 (회귀)" "$APPEARS_C" "1"

APPEARS_D=$("${PSQL[@]}" -c "SELECT count(*) FROM ($INBOX) t WHERE id='d0000000-0000-0000-0000-00000000000d'")
check "Conv D (feedback + 유저 답장) 노출" "$APPEARS_D" "1"

echo ""
echo "[반환 컬럼 정확성]"
UMC_A=$("${PSQL[@]}" -c "SELECT user_msg_count FROM admin_dm_inbox_page('$SYS'::uuid,NULL,NULL,51) WHERE id='a0000000-0000-0000-0000-00000000000a'")
check "Conv A user_msg_count=0 (유저 발신 없음)" "$UMC_A" "0"
ORIGIN_A=$("${PSQL[@]}" -c "SELECT origin FROM admin_dm_inbox_page('$SYS'::uuid,NULL,NULL,51) WHERE id='a0000000-0000-0000-0000-00000000000a'")
check "Conv A origin='feedback' 반환" "$ORIGIN_A" "feedback"
UNREAD_A=$("${PSQL[@]}" -c "SELECT unread_count FROM admin_dm_inbox_page('$SYS'::uuid,NULL,NULL,51) WHERE id='a0000000-0000-0000-0000-00000000000a'")
check "Conv A unread_count=0 (유저 미발신)" "$UNREAD_A" "0"
UNREAD_D=$("${PSQL[@]}" -c "SELECT unread_count FROM admin_dm_inbox_page('$SYS'::uuid,NULL,NULL,51) WHERE id='d0000000-0000-0000-0000-00000000000d'")
check "Conv D unread_count=1 (유저 답장 미읽음)" "$UNREAD_D" "1"
UMC_D=$("${PSQL[@]}" -c "SELECT user_msg_count FROM admin_dm_inbox_page('$SYS'::uuid,NULL,NULL,51) WHERE id='d0000000-0000-0000-0000-00000000000d'")
check "Conv D user_msg_count=1" "$UMC_D" "1"

echo ""
echo "[정렬 — last_message_at DESC]"
# 노출 대상은 D(04:00) > C(03:00) > A(01:00). B는 미노출.
ORDER=$("${PSQL[@]}" -c "SELECT string_agg(substr(id::text,1,1),',' ORDER BY rn) FROM (SELECT id, row_number() OVER () rn FROM admin_dm_inbox_page('$SYS'::uuid,NULL,NULL,51)) s")
check "정렬 D,C,A (broadcast B 제외)" "$ORDER" "d,c,a"

echo ""
echo "[클라 롤 실행 차단]"
R=$("${PSQL[@]}" -c "SELECT has_function_privilege('anon','admin_dm_inbox_page(uuid,timestamptz,uuid,int)','EXECUTE')")
check "anon EXECUTE 불가" "$R" "f"
R=$("${PSQL[@]}" -c "SELECT has_function_privilege('authenticated','admin_dm_inbox_page(uuid,timestamptz,uuid,int)','EXECUTE')")
check "authenticated EXECUTE 불가" "$R" "f"
R=$("${PSQL[@]}" -c "SELECT has_function_privilege('service_role','admin_dm_inbox_page(uuid,timestamptz,uuid,int)','EXECUTE')")
check "service_role EXECUTE 허용" "$R" "t"

echo ""
echo "결과: $pass pass / $fail fail"
[ "$fail" -eq 0 ]
