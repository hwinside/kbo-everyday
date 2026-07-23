-- 시작알림 정시-only 게이트 (2026-07-23, PR #796 post-merge 삼순 blocker 반영).
-- warmup cron이 "예정(state 1)" 상태를 마지막으로 관측한 시각을 기록해,
-- scheduled→live 전환을 최근 연속 관측한 경우에만 "경기 시작!"을 발송한다.
-- 첫 관측이 이미 live(장애 복구/재배포 직후)거나 관측이 오래됐으면 mark-only.
alter table game_notify_state
  add column if not exists last_seen_scheduled_at timestamptz;
