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

-- 원자적 발송: claim(unique) → dm insert → conversation 갱신을 한 트랜잭션으로 처리.
-- 이미 claim된 (notice_key,user_id)면 'skipped', 신규면 발송 후 'sent'. 오류는 raise(fail-closed).
create or replace function send_urgent_notice(
  p_notice_key text,
  p_user_id uuid,
  p_sender_id uuid,
  p_message text
) returns text
language plpgsql
security definer
as $$
declare
  v_conv_id uuid;
  v_u1 uuid;
  v_u2 uuid;
  v_msg_id bigint;
begin
  -- 원자 claim — 경합/재실행에서 최초 1회만 통과
  begin
    insert into urgent_notice_deliveries (notice_key, user_id) values (p_notice_key, p_user_id);
  exception when unique_violation then
    return 'skipped';
  end;

  -- conversation 보장 (user1 < user2 정렬)
  if p_sender_id < p_user_id then v_u1 := p_sender_id; v_u2 := p_user_id;
  else v_u1 := p_user_id; v_u2 := p_sender_id; end if;

  select id into v_conv_id from dm_conversations where user1_id = v_u1 and user2_id = v_u2;
  if v_conv_id is null then
    insert into dm_conversations (user1_id, user2_id) values (v_u1, v_u2) returning id into v_conv_id;
  end if;

  -- 공지 쪽지 insert (dispatch 트리거가 📢 푸시)
  insert into dm_messages (conversation_id, sender_id, content, payload)
  values (v_conv_id, p_sender_id, p_message,
          jsonb_build_object('type', 'urgent_notice', 'notice_key', p_notice_key))
  returning id into v_msg_id;

  update dm_conversations
    set last_message = left(p_message, 100), last_message_at = now()
    where id = v_conv_id;

  update urgent_notice_deliveries
    set conversation_id = v_conv_id, message_id = v_msg_id
    where notice_key = p_notice_key and user_id = p_user_id;

  return 'sent';
end;
$$;

alter table urgent_notice_deliveries enable row level security;
