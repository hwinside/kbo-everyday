#!/usr/bin/env bash
# admin_dm_inbox_page 수신함 노출 판정 통합 회귀 (삼순 PR #836 NO-GO blocker)
#
# 임시 로컬 Postgres 클러스터를 띄워 migration 의 RPC 를 실제로 적용한 뒤,
# origin(dm/feedback) × 메시지 구성(유저발신/운영팀발신/빈대화) 조합별 수신함
# 노출 여부를 고정한다:
#   1) system 이 user1 인 대화 — 유저 발신 1건+ → 노출 (기존 동작)
#   2) system 이 user2 인 대화 — 유저 발신 1건+ → 노출 (UNION 양쪽 정합)
#   3) 기존 welcome 대화(origin='dm', 운영팀 발신만) → 비노출 (feedback 승격 전)
#   4) 위 대화가 origin='feedback' 으로 승격되면(운영팀 발신만·유저발신0) → 노출 (핵심 blocker)
#   5) 신규 feedback 대화(origin='feedback', 운영팀 발신 1건) → 노출
#   6) 일반 dm 선발신(origin='dm', 운영팀 발신만) → 비노출
#   7) 메시지 0건 빈 대화(origin='dm') → 비노출
#   8) 메시지 0건 빈 대화(origin='feedback') 은 노출되나, 실제 코드는 메시지 성공 후에만
#      origin='feedback' 을 확정하므로 이 상태가 발생하지 않음을 명시(문서화 체크)
#   9) 클라 롤(anon) EXECUTE 차단, service_role EXECUTE 허용
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

MIGRATION="$(cd "$(dirname "$0")/../.." && pwd)/supabase/migrations/20260725_dm_conversation_origin.sql"
[ -f "$MIGRATION" ] || { echo "migration not found: $MIGRATION" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/admin-dm-feedback-qa.XXXXXX")"
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

# 의존 최소 스키마: RPC 가 참조하는 dm_conversations / dm_messages / profiles + 클라 롤.
# dm_conversations 는 migration 이 origin 컬럼을 ADD COLUMN 하므로 여기선 origin 없이 만든다.
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
  image_urls JSONB DEFAULT '[]'::jsonb,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL

# migration 적용 (origin 컬럼 + 인덱스 + RPC 재정의 + grant)
"${PSQL[@]}" -f "$MIGRATION" >/dev/null

# 고정 UUID
SYS='00000000-0000-4000-8000-000000000001'
U_A='00000000-0000-4000-8000-0000000000a1'   # welcome/feedback (system=user1)
U_B='00000000-0000-4000-8000-0000000000b2'   # 유저 발신 있음 (system=user2)
U_C='00000000-0000-4000-8000-0000000000c3'   # 신규 feedback
U_D='00000000-0000-4000-8000-0000000000d4'   # 일반 dm 선발신
U_E='00000000-0000-4000-8000-0000000000e5'   # 빈 대화(dm)

TS='2026-07-25T05:00:00Z'

"${PSQL[@]}" <<SQL
INSERT INTO profiles(id,nickname,team_id) VALUES
  ('$U_A','제보자A',1),('$U_B','유저B',2),('$U_C','신규C',3),
  ('$U_D','일반D',4),('$U_E','빈E',5);

-- system 이 user1 인 정렬 (sort 규칙과 무관하게 RPC 는 user1/user2 양쪽 UNION)
-- 대화1: system=user1, 유저(U_A) 발신 1건 + 운영팀 발신 → 노출
INSERT INTO dm_conversations(id,user1_id,user2_id,last_message,last_message_at) VALUES
  ('10000000-0000-4000-8000-000000000001','$SYS','$U_A','안녕','$TS');
INSERT INTO dm_messages(conversation_id,sender_id,content) VALUES
  ('10000000-0000-4000-8000-000000000001','$U_A','문의합니다'),
  ('10000000-0000-4000-8000-000000000001','$SYS','답변드려요');

-- 대화2: system=user2, 유저(U_B) 발신 1건 → 노출 (UNION 반대편)
INSERT INTO dm_conversations(id,user1_id,user2_id,last_message,last_message_at) VALUES
  ('20000000-0000-4000-8000-000000000002','$U_B','$SYS','문의','$TS');
INSERT INTO dm_messages(conversation_id,sender_id,content) VALUES
  ('20000000-0000-4000-8000-000000000002','$U_B','질문 있어요');

-- 대화3: welcome-dm 형태. origin='dm', 운영팀 발신만 (유저 발신 0) → 비노출
INSERT INTO dm_conversations(id,user1_id,user2_id,origin,last_message,last_message_at) VALUES
  ('30000000-0000-4000-8000-000000000003','$SYS','$U_C','dm','환영합니다','$TS');
INSERT INTO dm_messages(conversation_id,sender_id,content) VALUES
  ('30000000-0000-4000-8000-000000000003','$SYS','가입을 환영해요');

-- 대화4: 신규 feedback. origin='feedback', 운영팀 발신 1건 (유저 발신 0) → 노출
INSERT INTO dm_conversations(id,user1_id,user2_id,origin,last_message,last_message_at) VALUES
  ('40000000-0000-4000-8000-000000000004','$SYS','$U_D','feedback','건의 답변','$TS');
INSERT INTO dm_messages(conversation_id,sender_id,content) VALUES
  ('40000000-0000-4000-8000-000000000004','$SYS','건의 감사합니다');

-- 대화5: 일반 dm 선발신. origin='dm', 운영팀 발신만 → 비노출
INSERT INTO dm_conversations(id,user1_id,user2_id,origin,last_message,last_message_at) VALUES
  ('50000000-0000-4000-8000-000000000005','$SYS','$U_E','dm','공지','$TS');
INSERT INTO dm_messages(conversation_id,sender_id,content) VALUES
  ('50000000-0000-4000-8000-000000000005','$SYS','안내드립니다');

-- 대화6: 빈 대화 origin='dm' (메시지 0건) → 비노출
INSERT INTO dm_conversations(id,user1_id,user2_id,origin,last_message,last_message_at) VALUES
  ('60000000-0000-4000-8000-000000000006','$SYS','$U_E','dm',NULL,NULL);
SQL

pass=0; fail=0
check() { # name actual expected
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✅ $1"
  else fail=$((fail+1)); echo "  ❌ $1 (got: $2 / want: $3)"; fi
}
# 특정 conversation id 가 수신함 결과에 포함되면 1, 아니면 0
visible() {
  "${PSQL[@]}" -c "SELECT CASE WHEN EXISTS (SELECT 1 FROM admin_dm_inbox_page('$SYS'::uuid, NULL, NULL, 100) WHERE id = '$1'::uuid) THEN 1 ELSE 0 END"
}
umc() { # user_msg_count for a conversation
  "${PSQL[@]}" -c "SELECT user_msg_count FROM admin_dm_inbox_page('$SYS'::uuid, NULL, NULL, 100) WHERE id = '$1'::uuid"
}

echo "[기존 동작 — 유저 발신 1건+ 노출 (UNION 양쪽)]"
check "대화1 (system=user1, 유저 발신) 노출" "$(visible 10000000-0000-4000-8000-000000000001)" "1"
check "대화2 (system=user2, 유저 발신) 노출" "$(visible 20000000-0000-4000-8000-000000000002)" "1"

echo "[핵심 blocker — welcome(origin=dm, 운영팀만)은 비노출, feedback 승격 시 노출]"
check "대화3 welcome(origin=dm, 유저발신0) 비노출" "$(visible 30000000-0000-4000-8000-000000000003)" "0"
# route.ts 가 피드백 회신 성공 후 기존 대화 origin 을 feedback 으로 승격하는 상황 재현
"${PSQL[@]}" -c "UPDATE dm_conversations SET origin='feedback' WHERE id='30000000-0000-4000-8000-000000000003'" >/dev/null
check "대화3 origin='feedback' 승격 후 노출 (유저발신0인데도)" "$(visible 30000000-0000-4000-8000-000000000003)" "1"
check "  → 승격 대화 user_msg_count=0 이어도 노출됨" "$(umc 30000000-0000-4000-8000-000000000003)" "0"

echo "[신규 feedback 노출 / 일반 dm 선발신 비노출]"
check "대화4 신규 feedback(운영팀 발신 1건) 노출" "$(visible 40000000-0000-4000-8000-000000000004)" "1"
check "대화5 일반 dm 선발신(운영팀만) 비노출" "$(visible 50000000-0000-4000-8000-000000000005)" "0"

echo "[빈 대화 비노출 — 메시지 실패 시 origin=dm 유지로 누출 방지]"
check "대화6 빈 대화(origin=dm, 메시지0) 비노출" "$(visible 60000000-0000-4000-8000-000000000006)" "0"
# 안전망 문서화: 만약 빈 대화가 origin=feedback 이면 RPC 는 노출한다. 그래서 route.ts 는
# 반드시 "메시지 INSERT 성공 후"에만 origin 을 feedback 으로 확정해야 한다(코드 diff 로 보장).
"${PSQL[@]}" -c "UPDATE dm_conversations SET origin='feedback' WHERE id='60000000-0000-4000-8000-000000000006'" >/dev/null
check "  (음성대조) 빈 대화가 origin=feedback 이면 노출됨 → route.ts 마킹 순서 계약의 근거" \
  "$(visible 60000000-0000-4000-8000-000000000006)" "1"

echo "[클라 롤 실행 권한]"
R=$("${PSQL[@]}" -c "SELECT has_function_privilege('anon','admin_dm_inbox_page(uuid,timestamptz,uuid,int)','EXECUTE')")
check "anon EXECUTE 불가" "$R" "f"
R=$("${PSQL[@]}" -c "SELECT has_function_privilege('service_role','admin_dm_inbox_page(uuid,timestamptz,uuid,int)','EXECUTE')")
check "service_role EXECUTE 허용" "$R" "t"

echo ""
echo "결과: $pass pass / $fail fail"
[ "$fail" -eq 0 ]
