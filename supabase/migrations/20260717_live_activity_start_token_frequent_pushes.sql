-- Live Activity Broadcast 채널 Slice B (스펙 v4 §클라 4)
-- ActivityKit frequentPushesEnabled 진단용 보고 컬럼 — 발송 행동엔 무영향.
-- 클라(빌드 16+)가 register-start에 frequentPushes를 동봉하면 그대로 기록한다.
alter table public.live_activity_start_tokens
  add column if not exists frequent_pushes boolean;
