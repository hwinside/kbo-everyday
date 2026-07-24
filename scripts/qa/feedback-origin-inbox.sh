#!/usr/bin/env bash
# 건의함(피드백) 회신 대화의 운영팀 쪽지함 노출 + 원자 발송 RPC 통합 회귀.
#
# 임시 로컬 Postgres 클러스터를 띄워 migration 20260725_feedback_origin_inbox.sql 를
# 실제로 적용한 뒤, seed 가 아니라 **admin_send_ops_message RPC 를 실제 호출**해
# application path 와 실패 rollback 을 검증한다(삼순 round2 blocker):
#   1) 신규 feedback 발송 → 대화 생성 + 수신함 노출 + origin='feedback' (user_msg_count=0)
#   2) 기존 welcome 대화(origin='dm', 운영팀 발신만) → feedback 발송 → 승격 노출 (핵심 blocker)
#   3) 신규 feedback 메시지 INSERT 실패 → 전체 rollback → 대화 0건 · 노출 0 (원자성)
#   4) preview/origin UPDATE 실패 → 전체 rollback → 대화 0건 · RPC 예외(성공 반환 금지)
#   5) 일반 dm 발송(origin='dm') → 비노출 · origin='dm' 유지 (broadcast 무영향)
#   6) system 이 user1 / user2 인 양쪽 UNION 노출
#   7) dedup_key 멱등: 같은 키 재발송 → deduped · 메시지 1건 · 목록 순서 불변
#   8) foreign dedup_key 충돌(다른 대화의 키) → 예외 · rollback
#   9) origin CHECK 제약(dm/feedback 만) · 클라 롤 EXECUTE 차단 · service_role 허용
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
"$PGBIN/pg_ctl" -D "$DATADIR" -o "-p 59324 -k $SOCKDIR -c listen_addresses=''" -w start >/dev/null

PSQL=("$PGBIN/psql" -h "$SOCKDIR" -p 59324 -U qa -d postgres -v ON_ERROR_STOP=1 -qtA)

# 프로덕션과 동일한 최소 의존 스키마 + preview 트리거 + 클라 롤.
# dm_conversations 는 UNIQUE(user1,user2) (RPC upsert ON CONFLICT 대상),
# dm_messages 는 dedup_key UNIQUE INDEX + image_urls. origin 컬럼은 migration 이 추가.
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user1_id, user2_id)
);
CREATE TABLE dm_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES dm_conversations(id),
  sender_id UUID NOT NULL,
  content TEXT,
  image_urls TEXT[] NOT NULL DEFAULT '{}',
  dedup_key TEXT,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_dm_messages_dedup_key ON dm_messages (dedup_key) WHERE dedup_key IS NOT NULL;

-- 프로덕션 preview 동기화 트리거(20260722_dm_atomic_send.sql 동일)
CREATE OR REPLACE FUNCTION public.sync_dm_conversation_preview()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_preview TEXT;
BEGIN
  v_preview := COALESCE(nullif(btrim(new.content), ''),
    CASE WHEN COALESCE(cardinality(new.image_urls),0) > 0 THEN '[사진]' ELSE '[메시지]' END);
  UPDATE public.dm_conversations
    SET last_message = v_preview, last_message_at = new.created_at
    WHERE id = new.conversation_id
      AND (last_message_at IS NULL OR last_message_at <= new.created_at);
  RETURN new;
END;$$;
CREATE TRIGGER trg_sync_dm_conversation_preview
  AFTER INSERT ON public.dm_messages
  FOR EACH ROW EXECUTE FUNCTION public.sync_dm_conversation_preview();

-- 장애 주입 트리거: 특정 마커로 메시지 INSERT / 대화 UPDATE 를 강제 실패시켜
-- RPC 트랜잭션 rollback 을 검증한다(테스트 전용).
CREATE FUNCTION qa_fail_msg() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF new.content = '__FAIL_MSG__' THEN RAISE EXCEPTION 'qa forced message failure'; END IF;
  RETURN new;
END;$$;
CREATE TRIGGER trg_qa_fail_msg BEFORE INSERT ON public.dm_messages
  FOR EACH ROW EXECUTE FUNCTION qa_fail_msg();
CREATE FUNCTION qa_fail_upd() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF new.last_message = '__FAIL_UPD__' THEN RAISE EXCEPTION 'qa forced update failure'; END IF;
  RETURN new;
END;$$;
CREATE TRIGGER trg_qa_fail_upd BEFORE UPDATE ON public.dm_conversations
  FOR EACH ROW EXECUTE FUNCTION qa_fail_upd();

INSERT INTO profiles(id, nickname, team_id) VALUES
  ('00000000-0000-0000-0000-000000000001', '운영팀', NULL),
  ('00000000-0000-0000-0000-000000000000', '유저G', 7),
  ('11111111-1111-1111-1111-111111111111', '유저A', 1),
  ('22222222-2222-2222-2222-222222222222', '유저B', 2),
  ('33333333-3333-3333-3333-333333333333', '유저C', 3),
  ('44444444-4444-4444-4444-444444444444', '유저D', 4),
  ('55555555-5555-5555-5555-555555555555', '유저E', 5),
  ('66666666-6666-6666-6666-666666666666', '유저F', 6);
SQL

"${PSQL[@]}" -f "$MIGRATION" >/dev/null

SYS='00000000-0000-0000-0000-000000000001'
U_A='11111111-1111-1111-1111-111111111111'  # 신규 feedback
U_B='22222222-2222-2222-2222-222222222222'  # 기존 welcome → feedback 승격
U_C='33333333-3333-3333-3333-333333333333'  # 메시지 실패 rollback
U_D='44444444-4444-4444-4444-444444444444'  # UPDATE 실패 rollback
U_E='55555555-5555-5555-5555-555555555555'  # 일반 dm (비노출)
U_F='66666666-6666-6666-6666-666666666666'  # dedup 멱등
U_G='00000000-0000-0000-0000-000000000000'  # system=user2 UNION (SYS 보다 작은 uuid)

pass=0 fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✅ $1"; else fail=$((fail+1)); echo "  ❌ $1 (got: $2 / want: $3)"; fi; }

# RPC 호출: 성공 시 conversation_id, 실패 시 'ERR' 반환
rpc_send() { # sys user content preview origin dedup
  local dedup="NULL"; [ -n "${6:-}" ] && dedup="'$6'"
  local out
  if out=$("${PSQL[@]}" -c "SELECT conversation_id FROM admin_send_ops_message('$1'::uuid,'$2'::uuid,'$3','{}'::text[],'$4','$5',$dedup)" 2>/dev/null); then
    echo "$out"
  else echo "ERR"; fi
}
# 수신함에 해당 유저 대화가 보이면 1
visible() { "${PSQL[@]}" -c "SELECT CASE WHEN EXISTS(SELECT 1 FROM admin_dm_inbox_page('$SYS'::uuid,NULL,NULL,100) WHERE other_user_id='$1'::uuid) THEN 1 ELSE 0 END"; }
# (sys,user) pair 대화 개수
pair_cnt() { "${PSQL[@]}" -c "SELECT count(*) FROM dm_conversations WHERE (user1_id='$SYS' AND user2_id='$1') OR (user1_id='$1' AND user2_id='$SYS')"; }
conv_origin() { "${PSQL[@]}" -c "SELECT origin FROM dm_conversations WHERE (user1_id='$SYS' AND user2_id='$1') OR (user1_id='$1' AND user2_id='$SYS')"; }
umc() { "${PSQL[@]}" -c "SELECT user_msg_count FROM admin_dm_inbox_page('$SYS'::uuid,NULL,NULL,100) WHERE other_user_id='$1'::uuid"; }
msg_cnt() { "${PSQL[@]}" -c "SELECT count(*) FROM dm_messages m JOIN dm_conversations c ON c.id=m.conversation_id WHERE (c.user1_id='$SYS' AND c.user2_id='$1') OR (c.user1_id='$1' AND c.user2_id='$SYS')"; }

echo "[1) 신규 feedback 발송 → 대화 생성 + 노출 + origin=feedback]"
R=$(rpc_send "$SYS" "$U_A" '건의 감사합니다' '건의 감사합니다' 'feedback')
check "RPC 성공(conversation_id 반환)" "$([ "$R" != "ERR" ] && [ -n "$R" ] && echo ok)" "ok"
check "수신함 노출" "$(visible "$U_A")" "1"
check "origin=feedback 마킹" "$(conv_origin "$U_A")" "feedback"
check "유저 발신 0건인데도 노출(user_msg_count=0)" "$(umc "$U_A")" "0"

echo "[2) 기존 welcome 대화(origin=dm, 운영팀 발신만) → feedback 발송 승격 노출 — 핵심 blocker]"
"${PSQL[@]}" -c "INSERT INTO dm_conversations(user1_id,user2_id,origin,last_message,last_message_at) VALUES('$SYS','$U_B','dm','환영합니다',now())" >/dev/null
"${PSQL[@]}" -c "INSERT INTO dm_messages(conversation_id,sender_id,content) SELECT id,'$SYS','가입 환영' FROM dm_conversations WHERE user1_id='$SYS' AND user2_id='$U_B'" >/dev/null
check "승격 전 welcome 비노출" "$(visible "$U_B")" "0"
R=$(rpc_send "$SYS" "$U_B" '건의 답변드려요' '건의 답변드려요' 'feedback')
check "RPC 성공" "$([ "$R" != "ERR" ] && echo ok)" "ok"
check "승격 후 노출" "$(visible "$U_B")" "1"
check "origin=feedback 승격" "$(conv_origin "$U_B")" "feedback"
check "기존 대화 재사용(pair 1건, 중복 방생성 없음)" "$(pair_cnt "$U_B")" "1"

echo "[3) 신규 feedback 메시지 INSERT 실패 → 전체 rollback (원자성)]"
R=$(rpc_send "$SYS" "$U_C" '__FAIL_MSG__' 'preview' 'feedback')
check "RPC 예외 반환(ERR)" "$R" "ERR"
check "대화 미생성(pair 0건)" "$(pair_cnt "$U_C")" "0"
check "수신함 노출 0" "$(visible "$U_C")" "0"

echo "[4) preview/origin UPDATE 실패 → 전체 rollback + 성공 반환 금지]"
R=$(rpc_send "$SYS" "$U_D" '정상내용' '__FAIL_UPD__' 'feedback')
check "RPC 예외 반환(ERR)" "$R" "ERR"
check "대화 미생성(pair 0건)" "$(pair_cnt "$U_D")" "0"
check "메시지도 rollback(0건)" "$(msg_cnt "$U_D")" "0"

echo "[5) 일반 dm 발송(origin=dm) → 비노출 · origin 유지]"
R=$(rpc_send "$SYS" "$U_E" '공지드립니다' '공지드립니다' 'dm')
check "RPC 성공" "$([ "$R" != "ERR" ] && echo ok)" "ok"
check "origin=dm 유지" "$(conv_origin "$U_E")" "dm"
check "일반 dm 선발신 비노출" "$(visible "$U_E")" "0"

echo "[6) system=user2 UNION 노출 (정렬상 system 이 user2 가 되는 pair)]"
# U_G(nil uuid) 는 SYS(...0001) 보다 작아 (user1=U_G, user2=SYS) 로 정렬됨 → UNION 반대편 branch
R=$(rpc_send "$SYS" "$U_G" '반대편 회신' '반대편 회신' 'feedback')
U1=$("${PSQL[@]}" -c "SELECT CASE WHEN user1_id='$SYS' THEN 'sys_u1' ELSE 'sys_u2' END FROM dm_conversations WHERE (user1_id='$SYS' AND user2_id='$U_G') OR (user1_id='$U_G' AND user2_id='$SYS')")
check "pair 정렬에서 system=user2 배치 확인" "$U1" "sys_u2"
check "UNION 반대편도 노출" "$(visible "$U_G")" "1"

echo "[7) dedup_key 멱등 — 재발송은 deduped · 메시지 1건 · 순서 불변]"
DK='blind-notify-U_F-1'
R1=$(rpc_send "$SYS" "$U_F" '중복방지 메시지' '중복방지 메시지' 'dm' "$DK")
LMA1=$("${PSQL[@]}" -c "SELECT last_message_at FROM dm_conversations WHERE (user1_id='$SYS' AND user2_id='$U_F') OR (user1_id='$U_F' AND user2_id='$SYS')")
DED=$("${PSQL[@]}" -c "SELECT deduped FROM admin_send_ops_message('$SYS'::uuid,'$U_F'::uuid,'중복방지 메시지','{}'::text[],'중복방지 메시지','dm','$DK')")
check "2차 발송 deduped=true" "$DED" "t"
check "dedup 메시지 1건만 존재" "$("${PSQL[@]}" -c "SELECT count(*) FROM dm_messages WHERE dedup_key='$DK'")" "1"
LMA2=$("${PSQL[@]}" -c "SELECT last_message_at FROM dm_conversations WHERE (user1_id='$SYS' AND user2_id='$U_F') OR (user1_id='$U_F' AND user2_id='$SYS')")
check "재발송이 목록 순서(last_message_at) 안 바꿈" "$LMA1" "$LMA2"

echo "[8) foreign dedup_key 충돌(다른 대화의 키) → 예외 · rollback]"
# U_A 대화에 이미 쓰인 dedup key 를 U_E 대화로 재사용 시도 → UNIQUE 충돌, 우리 대화 아님 → ERR
"${PSQL[@]}" -c "UPDATE dm_messages SET dedup_key='shared-key-1' WHERE conversation_id=(SELECT id FROM dm_conversations WHERE user1_id='$SYS' AND user2_id='$U_A')" >/dev/null 2>&1 || \
  "${PSQL[@]}" -c "UPDATE dm_messages SET dedup_key='shared-key-1' WHERE conversation_id=(SELECT id FROM dm_conversations WHERE (user1_id='$SYS' AND user2_id='$U_A') OR (user1_id='$U_A' AND user2_id='$SYS')) AND id=(SELECT min(id) FROM dm_messages)" >/dev/null
BEFORE_E=$(msg_cnt "$U_E")
R=$(rpc_send "$SYS" "$U_E" '다른대화 키 도용' '다른대화 키 도용' 'dm' 'shared-key-1')
check "foreign dedup 충돌 시 예외(ERR)" "$R" "ERR"
check "U_E 대화 메시지 증가 없음(rollback)" "$(msg_cnt "$U_E")" "$BEFORE_E"

echo "[9) origin CHECK 제약 · 롤 권한]"
R=$("${PSQL[@]}" -c "INSERT INTO dm_conversations(user1_id,user2_id,origin) VALUES('$SYS','$U_A','bogus'); SELECT 'ok'" 2>&1 | tail -1)
check "origin CHECK 위반 거부(dm/feedback 만)" "$([ "$R" = "ok" ] && echo bad || echo blocked)" "blocked"
R=$("${PSQL[@]}" -c "SELECT has_function_privilege('anon','admin_send_ops_message(uuid,uuid,text,text[],text,text,text)','EXECUTE')")
check "anon admin_send_ops_message EXECUTE 불가" "$R" "f"
R=$("${PSQL[@]}" -c "SELECT has_function_privilege('service_role','admin_send_ops_message(uuid,uuid,text,text[],text,text,text)','EXECUTE')")
check "service_role EXECUTE 허용" "$R" "t"
R=$("${PSQL[@]}" -c "SELECT has_function_privilege('anon','admin_dm_inbox_page(uuid,timestamptz,uuid,int)','EXECUTE')")
check "anon admin_dm_inbox_page EXECUTE 불가" "$R" "f"

echo ""
echo "결과: $pass pass / $fail fail"
[ "$fail" -eq 0 ]
