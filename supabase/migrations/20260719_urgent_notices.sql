-- 긴급공지 SSOT (2026-07-19)
-- 긴급공지 계정(URGENT_NOTICE_USER_ID)이 발송하는 공지의 원본 텍스트 + 활성 게이트.
-- 기존 유저 배치 발송과 신규 가입 자동 발송이 이 테이블을 공용 SSOT로 읽는다.
-- active=false 로 내리면(예: 심사 승인 시) 신규 가입 자동 발송이 즉시 멈춘다.
-- service_role 전용 (RLS on, 정책 없음 = 클라 직접 접근 차단).

create table if not exists urgent_notices (
  notice_key text primary key,
  message text not null,
  target_platform text not null default 'android', -- 'android' | 'ios' | 'all'
  active boolean not null default true,
  created_at timestamptz not null default now(),
  deactivated_at timestamptz
);

alter table urgent_notices enable row level security;

-- 공지 발송 원장 (삼순 NO-GO #2: 멱등 원자화) — (notice_key,user_id) unique claim.
-- check-then-insert 경합/재실행 중복을 DB unique 제약으로 원천 차단하고, 발송 이력을 영구 보존.
create table if not exists urgent_notice_deliveries (
  notice_key text not null,
  user_id uuid not null,
  conversation_id uuid,
  message_id bigint,
  delivered_at timestamptz not null default now(),
  primary key (notice_key, user_id)
);

alter table urgent_notice_deliveries enable row level security;

-- 발송 결과 로그 (삼순 NO-GO #4: 실패도 영구 기록) — claim rollback 없이 남긴다.
create table if not exists urgent_notice_send_log (
  id bigint generated always as identity primary key,
  notice_key text not null,
  user_id uuid not null,
  result text not null,        -- 'sent' | 'skipped' | 'inactive' | 'platform_skip' | 'error'
  detail text,
  created_at timestamptz not null default now()
);

alter table urgent_notice_send_log enable row level security;

-- 발신 계정 SSOT — RPC가 하드코딩된 sender를 쓰지 않도록 상수 조회 함수(단일 소스).
-- 계정 UUID 변경 시 이 함수만 고치면 된다. src/lib/constants/urgent-notice.ts와 동일 값.
create or replace function urgent_notice_sender_id() returns uuid
language sql immutable
as $$ select 'cea40688-d0ff-49bd-a101-4b7cf9339b0e'::uuid $$;

-- 원자적 발송 (삼순 P0/#1/#2 반영):
--   * 인자는 notice_key,user_id,platform만 — sender/message/active/target은 DB SSOT에서 읽는다
--     (호출자 입력 sender·문안 위조 불가).
--   * urgent_notices에서 active=true + target platform 일치 확인을 claim과 같은 트랜잭션에서 수행
--     (deactivate 뒤 남은 대상 발송 차단, welcome race 제거).
--   * claim(unique) → dm insert → conversation 갱신을 한 트랜잭션. 실패는 raise(fail-closed).
--   * SECURITY DEFINER + SET search_path, 실행권한은 service_role 전용(아래 REVOKE/GRANT).
create or replace function send_urgent_notice(
  p_notice_key text,
  p_user_id uuid,
  p_platform text
) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sender_id uuid := urgent_notice_sender_id();
  v_message text;
  v_target text;
  v_active boolean;
  v_conv_id uuid;
  v_u1 uuid;
  v_u2 uuid;
  v_msg_id bigint;
begin
  if p_user_id = v_sender_id then
    return 'skipped';
  end if;

  -- SSOT 조회 + active/target 게이트 — 삼순 #1: `FOR SHARE`로 notice 행을 잠그어
  -- deactivate의 UPDATE(row exclusive)과 직렬화한다. 잠금 순서 불변식:
  --   (a) RPC가 FOR SHARE 먼저 → deactivate UPDATE는 RPC commit까지 대기(그 1건은 발송되나
  --       deactivate '반환 후' 신규 RPC는 이미 active=false를 읽음)
  --   (b) deactivate가 먼저 commit → RPC FOR SHARE는 최신 커밋된 active=false 읽음 → inactive.
  -- ∴ deactivate 반환 시점 이후 시작하는 모든 발송은 0건(kill switch 보장).
  select message, target_platform, active
    into v_message, v_target, v_active
    from urgent_notices where notice_key = p_notice_key
    for share;
  if not found or not v_active then
    insert into urgent_notice_send_log (notice_key, user_id, result, detail)
    values (p_notice_key, p_user_id, 'inactive', 'notice missing or inactive');
    return 'inactive';
  end if;
  -- platform 게이트(삼순 #3 fail-closed): notice target이 'all'이 아니면 호출 platform과
  -- 정확히 일치해야 발송. p_platform은 필수이며 NULL/불일치는 IS DISTINCT FROM으로 차단.
  if v_target <> 'all' and p_platform is distinct from v_target then
    insert into urgent_notice_send_log (notice_key, user_id, result, detail)
    values (p_notice_key, p_user_id, 'platform_skip', coalesce(p_platform, 'null'));
    return 'platform_skip';
  end if;

  -- 원자 claim — 경합/재실행에서 최초 1회만 통과
  begin
    insert into urgent_notice_deliveries (notice_key, user_id) values (p_notice_key, p_user_id);
  exception when unique_violation then
    return 'skipped';
  end;

  -- conversation 보장 (user1 < user2 정렬)
  if v_sender_id < p_user_id then v_u1 := v_sender_id; v_u2 := p_user_id;
  else v_u1 := p_user_id; v_u2 := v_sender_id; end if;

  select id into v_conv_id from dm_conversations where user1_id = v_u1 and user2_id = v_u2;
  if v_conv_id is null then
    insert into dm_conversations (user1_id, user2_id) values (v_u1, v_u2) returning id into v_conv_id;
  end if;

  -- 공지 쪽지 insert (dispatch 트리거가 📢 푸시)
  insert into dm_messages (conversation_id, sender_id, content, payload)
  values (v_conv_id, v_sender_id, v_message,
          jsonb_build_object('type', 'urgent_notice', 'notice_key', p_notice_key))
  returning id into v_msg_id;

  update dm_conversations
    set last_message = left(v_message, 100), last_message_at = now()
    where id = v_conv_id;

  update urgent_notice_deliveries
    set conversation_id = v_conv_id, message_id = v_msg_id
    where notice_key = p_notice_key and user_id = p_user_id;

  insert into urgent_notice_send_log (notice_key, user_id, result) values (p_notice_key, p_user_id, 'sent');
  return 'sent';
end;
$$;

-- 삼순 P0: SECURITY DEFINER 함수의 기본 PUBLIC 실행권한 회수 → service_role만 호출.
revoke execute on function send_urgent_notice(text, uuid, text) from public, anon, authenticated;
grant execute on function send_urgent_notice(text, uuid, text) to service_role;

-- 삼순 #2: RPC 트랜잭션 rollback과 무관하게 실패를 영구 기록하는 별도 함수(자기 트랜잭션).
-- send.ts의 RPC 오류 catch에서 호출 — send_urgent_notice가 raise해 롤백도도 이 insert는 살아남는다.
create or replace function log_urgent_notice_error(
  p_notice_key text,
  p_user_id uuid,
  p_detail text
) returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into urgent_notice_send_log (notice_key, user_id, result, detail)
  values (p_notice_key, p_user_id, 'error', left(coalesce(p_detail, ''), 500));
$$;

revoke execute on function log_urgent_notice_error(text, uuid, text) from public, anon, authenticated;
grant execute on function log_urgent_notice_error(text, uuid, text) to service_role;
