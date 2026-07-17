-- 팀 설정/변경 이벤트 기반 즉시 start의 pending trigger (삼순 5조건 ④)
--
-- 온보딩(/api/setup)·최애팀 변경 시점에 현재 live/윈도우 최애팀 경기가 있으면 즉시
-- p2s start를 시도하는데, p2s 토큰 등록(register-start)과 팀 설정의 완료 순서는 보장이
-- 없다 — 토큰이 아직 없으면 이 테이블에 trigger를 남기고, register-start가 토큰 등록
-- 직후 소비(delete returning)해 즉시 start로 닫는다(순서 race 봉합).
--
-- user_id PK = 유저당 1행(최신 이벤트만 유지). TTL(2h, 정책 상수)은 소비 시점에 판정 —
-- 지난 이벤트가 한참 뒤 앱 실행에서 뜬금없이 start를 쏘지 않게 한다.
create table if not exists live_activity_pending_start_triggers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  reason text not null check (reason in ('setup', 'team_change')),
  client_install_fresh boolean not null default false,
  requested_at timestamptz not null default now()
);

alter table live_activity_pending_start_triggers enable row level security;
-- 정책 없음 = service_role 전용 (서버 라우트만 접근)
