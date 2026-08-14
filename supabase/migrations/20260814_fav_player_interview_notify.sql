-- 최애선수 수훈선수 인터뷰 알림 (fav-player-interview.ts, 2026-08-14 하린아빠 요청)
--
-- 1) 토글 컬럼 — 디폴트 on(기존 row/유저 전부 on 유지, 백필 불필요).
alter table notification_prefs
  add column if not exists fav_player_interview boolean not null default true;

-- 2) 발송 상태 머신 (삼순 NO-GO 4라운드: in-flight와 완료를 분리하는 row lease/status).
--    pending    : 미발송 — 다음 cron이 집어간다
--    processing : 어떤 run이 lease를 잡고 발송 진행 중 — lease_until 전에는 다른 run이
--                 건드리지 못한다. lease 만료 후에도 processing이면 그 run이 죽은 것
--                 → 재획득 가능(sent 마커로 이중발송 방어)
--    sent       : 발송 종결(성공, 대상 0, 선수 미확정 포함)
alter table postgame_interviews
  add column if not exists notify_state text not null default 'pending'
    check (notify_state in ('pending', 'processing', 'sent'));
alter table postgame_interviews
  add column if not exists notify_lease_until timestamptz;

-- 3) 🔴 backlog 방어: 이 마이그레이션 이전에 저장된 인터뷰는 전부 sent로 백필한다.
--    백필하지 않으면 배포 직후 첫 cron이 과거 인터뷰 전량을 최애선수 팬에게
--    일괄 발송한다(#274 backlog 플러시와 동일 사고).
update postgame_interviews
   set notify_state = 'sent'
 where notify_state <> 'sent';

-- 4) 미발송 행 조회 인덱스 (cron이 매 5분 조회).
create index if not exists idx_postgame_interviews_notify_pending
  on postgame_interviews (published_at)
  where notify_state <> 'sent' and confidence = 'high';
