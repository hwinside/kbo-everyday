-- 잠금화면 1.0.9 종결 보완 (2026-07-17 삼순 NO-GO ②④, #product 1784295000.099849)
--
-- ② broadcast 유실 자가회복 heartbeat 판정용 — 채널별 마지막 broadcast 발송 시각.
--    broadcast는 No-Message-Stored(apns-expiration:0)라 기기가 순간 unreachable이면 그
--    1건이 영구 유실되고, 무변화 스킵과 겹치면 다음 상태 변화까지 stale로 고착된다.
--    2분 주기 heartbeat 재전송(p5, full snapshot)으로 자가 회복.
alter table live_activity_channels
  add column if not exists last_broadcast_at timestamptz;

-- ④ 동일 토큰 재설치 판별 — 클라 install generation (localStorage UUID).
--    재설치 시 WKWebView 스토리지가 초기화돼 재생성되므로, iOS가 재설치에도 *동일한*
--    p2s 토큰을 재발급하는 케이스(#667 명기 한계)를 서버가 세대 변화로 감지한다.
alter table live_activity_start_tokens
  add column if not exists install_generation text;
