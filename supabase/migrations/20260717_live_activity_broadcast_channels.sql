-- 잠금화면 Live Activity — iOS 18 Broadcast Push 채널 전환 (스펙 v4, #cs 1784203900.246869)
-- 경기당 APNs broadcast 채널로 전 유저 카드를 1건 발송으로 갱신해 per-디바이스
-- 업데이트 예산 스로틀(2026-07-16 인시던트)을 구조적으로 제거한다.

-- 경기×환경별 broadcast 채널 (환경별 APNs 네임스페이스가 분리돼 있어 PK에 env 포함)
create table if not exists live_activity_channels (
  game_id text not null,
  environment text not null check (environment in ('production', 'sandbox')),
  channel_id text not null,
  status text not null default 'active' check (status in ('active', 'ending', 'deleted')),
  -- priority 10/5 판정용 직전 상태 (점수/이닝/주자 = 10, 그 외 변화 = 5, 무변화 = 스킵)
  last_score_state text,
  last_state_hash text,
  -- 종료 end broadcast backoff 재시도 (즉시→1m→5m→15m→30m→1h 간격, 8h 후 DELETE)
  attempt_count int not null default 0,
  next_retry_at timestamptz,
  created_at timestamptz not null default now(),
  ending_at timestamptz,
  deleted_at timestamptz,
  primary key (game_id, environment)
);

alter table live_activity_channels enable row level security;
-- 정책 없음 = service_role 전용 (서버 크론/라우트만 접근)

-- 채널 구독 SSOT — 네이티브 ACK만 기록 (APNs 200 추정 마킹 금지, 스펙 v3 blocker①)
-- device_key = 서버가 검증한 pushToStartToken에서 derive한 해시 (클라 입력 불신, 조건부 GO 정정①)
create table if not exists live_activity_channel_subscriptions (
  game_id text not null,
  device_key text not null,
  environment text not null check (environment in ('production', 'sandbox')),
  channel_id text not null,
  user_id uuid references auth.users (id) on delete cascade,
  confirmed_at timestamptz not null default now(),
  primary key (game_id, device_key, environment)
);

create index if not exists la_channel_subs_game_user_idx
  on live_activity_channel_subscriptions (game_id, user_id);

alter table live_activity_channel_subscriptions enable row level security;
-- 정책 없음 = service_role 전용 (ACK 라우트가 토큰 검증 후 기록)

-- p2s 토큰 메타 — env(성공한 APNs 환경 기록·이후 고정), 클라 명시 보고 빌드/OS
-- (input-push-channel 게이트 = os_major>=18 && app_build>=16, 미보고 null = 레거시)
alter table live_activity_start_tokens
  add column if not exists apns_environment text
    check (apns_environment in ('production', 'sandbox')),
  add column if not exists app_build int,
  add column if not exists os_major int;
