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
