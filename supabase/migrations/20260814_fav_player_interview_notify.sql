-- 최애선수 수훈선수 인터뷰 알림 (fav-player-interview.ts, 2026-08-14 하린아빠 요청)
--
-- 1) 토글 컬럼 — 디폴트 on(기존 row/유저 전부 on 유지, 백필 불필요).
alter table notification_prefs
  add column if not exists fav_player_interview boolean not null default true;

-- 2) 발송 원장 — postgame_interviews 행 단위로 "알림 처리 완료" 시각을 남긴다.
--    이번 run에 새로 insert된 행만 대상으로 삼으면 발송이 실패했을 때 다음 run에는
--    이미 저장된 행이라 재입력되지 않아 영구 유실된다(삼순 NO-GO). notified_at이
--    null인 행을 매 run 다시 집어오는 구조라야 durable retry가 성립한다.
alter table postgame_interviews
  add column if not exists notified_at timestamptz;

-- 3) 🔴 backlog 방어: 이 마이그레이션 이전에 저장된 인터뷰는 전부 처리완료로 백필한다.
--    백필하지 않으면 배포 직후 첫 cron이 과거 인터뷰 전량을 최애선수 팬에게
--    일괄 발송한다(#274 backlog 플러시와 동일 사고).
update postgame_interviews
   set notified_at = now()
 where notified_at is null;

-- 4) 미발송 행 조회 인덱스 (cron이 매 5분 조회).
create index if not exists idx_postgame_interviews_pending_notify
  on postgame_interviews (published_at)
  where notified_at is null and confidence = 'high';
