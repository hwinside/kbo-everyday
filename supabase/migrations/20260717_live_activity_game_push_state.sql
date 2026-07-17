-- 잠금화면 LA 레거시(per-토큰) 경로 예산 스로틀 핫픽스 (#cs 1784260336.575949)
-- #659의 무변화 스킵 + priority 10/5 믹스는 직전 상태를 live_activity_channels 행에서만
-- 읽는다 → Broadcast Capability 미활성(채널 행 0)이면 항상 priority 10 매분 발송 =
-- 예산 소진 스로틀이 그대로 재발. 채널과 무관한 경기 단위 직전 상태를 저장해
-- Capability OFF 상태에서도 스킵/믹스가 돌게 한다. 채널 행(production)이 있으면 그쪽 우선.
create table if not exists live_activity_game_push_state (
  game_id text primary key,
  last_score_state text,
  last_state_hash text,
  updated_at timestamptz not null default now()
);

alter table live_activity_game_push_state enable row level security;
-- 정책 없음 = service_role 전용 (warmup 크론만 접근)
