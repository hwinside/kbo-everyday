-- 최애선수 수훈선수 인터뷰 알림 (fav-player-interview.ts, 2026-08-14 하린아빠 요청)
-- 토글 컬럼 — 디폴트 on(기존 row/유저 전부 on 유지, 백필 불필요).
-- dedup 원장은 notified_score_events 재사용(event_id = interview#{videoId}#{kboId})이라
-- 신규 테이블 없음.
ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS fav_player_interview BOOLEAN NOT NULL DEFAULT true;
