-- Live Activity push-to-start — (게임,유저) 단위 1회 발송 선점 마커.
-- 버그: 기존 live_activity_started(게임 단위 1회)는 경기 30분 전 윈도우의 *첫 cron*이
-- 게임을 선점하면, 그 시점 이후 등록된 push-to-start 토큰(예: 경기 직전 앱 첫 실행)이
-- 영영 발송에서 제외됐다(매분 cron이 "이미 선점됨"으로 skip). 대부분 유저가 경기 직전
-- 앱을 켜므로 사실상 광범위. 유저 단위 선점으로 바꿔 늦게 등록된 토큰도 그 시점 cron이
-- 처음 선점 → 발송되게 한다. 서버 service_role 전용(정책 없음 = 클라 접근 차단).
-- (기존 live_activity_started 테이블은 더 이상 사용 안 함 — 후속 정리 대상.)

create table if not exists public.live_activity_started_users (
  game_id     text not null,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (game_id, user_id)
);

alter table public.live_activity_started_users enable row level security;
