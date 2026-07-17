-- 채널 broadcast 미수신 단말 heartbeat (삼순 1.0.9(16) 5조건 재판정 blocker①)
-- broadcast는 No-Message-Stored(apns-expiration:0)라 accepted여도 미수신 단말엔 저장/재송신이
-- 없다. 상태 무변화 구간에서 한 번 놓친 단말은 다음 상태 변화까지 프리즈 → last_broadcast_at
-- 기준 2분 경과 시 동일 content p5 heartbeat 재방송으로 고착을 ≤3분으로 바운드한다.
alter table live_activity_channels
  add column if not exists last_broadcast_at timestamptz;
