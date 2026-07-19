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
