-- #13xx 잠금화면 카드 지연 후속(삼순 2026-08-27 조건부 GO):
-- ① retreat 중 heartbeat 복구 재료 — 마지막 성공 발송 콘텐츠 보존
-- ② p5 코얼레싱 기준 — 마지막 성공 발송 시각(p10/p5 불문)
-- 기존 행은 null 로 남고(fail-safe: 재전송/코얼레싱 미적용 = 기존 동작), 첫 성공 발송부터 채워진다.
alter table public.live_activity_channels
  add column if not exists last_send_at timestamptz,
  add column if not exists last_content_state jsonb;
