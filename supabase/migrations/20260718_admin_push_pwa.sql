-- 어드민 PWA 웹푸시 (2026-07-18)
-- 어드민 홈화면 웹앱(PIN 인증 기기 전용) 알림: 새 쪽지 / 새 건의 / 크롤러·배치 이상.
-- 두 테이블 모두 service_role 전용 (RLS on, 정책 없음 = 클라 직접 접근 차단).

create table if not exists admin_push_subscriptions (
  endpoint text primary key,
  subscription jsonb not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

alter table admin_push_subscriptions enable row level security;

-- 크롤러/배치 헬스 직전 레벨 스냅샷 — "상태 전이 시에만" 푸시 (반복 알림 방지)
create table if not exists admin_alert_state (
  job_name text primary key,
  level text not null,
  reason text,
  updated_at timestamptz not null default now()
);

alter table admin_alert_state enable row level security;

-- 어드민 세션 (삼순 P0 반영): PIN 원문 클라 저장 금지 → 서버 발급 기기별 세션.
-- 토큰은 sha256 해시만 저장, 행 delete/revoked_at 마킹 = 해당 기기 즉시 폐기.
create table if not exists admin_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_agent text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

alter table admin_sessions enable row level security;

-- 쪽지 알림 메시지당 1회 claim (삼순 P1 반영): message_id PK로 동시 요청/replay에서도 최초 1회만 발송.
-- sender_id+created_at은 발신자별 rate limit 조회용.
create table if not exists admin_dm_notify_claims (
  message_id uuid primary key,
  conversation_id uuid not null,
  sender_id uuid not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_admin_dm_notify_claims_sender_time
  on admin_dm_notify_claims (sender_id, created_at desc);

alter table admin_dm_notify_claims enable row level security;
