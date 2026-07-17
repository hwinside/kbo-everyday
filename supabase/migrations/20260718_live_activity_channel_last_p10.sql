-- 채널 broadcast heartbeat/catch-up (#659 후속, 삼순 5조건 ②)
--
-- 채널 broadcast는 No-Message-Stored(message-storage-policy: 0) + apns-expiration: 0으로
-- 발송한다 — APNs가 미접속 단말용으로 저장하지 않으므로, accepted push 1건을 단말이
-- 놓치면(무선 순단·재연결 등) 무변화 스킵 정책상 다음 상태 변화까지 stale이 3분을 넘을
-- 수 있다. active live 채널마다 마지막 *성공* p10 broadcast 시각을 저장하고, 상태
-- 무변화 틱이어도 ≤2분 간격으로 p10 current-state heartbeat를 재발송하는 판정 재료.
--
-- 기록은 APNs 성공 시에만 전진(transient 실패 시 전진 금지) + channelMutationFence
-- (game, env, channel_id) 일치 시에만 — 동시 cron/재생성 채널 보호는 기존 규칙 그대로.
-- backfill null = 즉시 heartbeat 대상(다음 틱 p10 1회 후 정상 추적).
alter table live_activity_channels
  add column if not exists last_p10_at timestamptz;
