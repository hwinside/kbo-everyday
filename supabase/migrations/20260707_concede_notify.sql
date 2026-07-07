-- 내 팀 실점 알림 (고객 기능 제안 2026-07-07, notifyScoreEvents concede 발송)
-- 토글 컬럼 — 디폴트 off(옵트인). 득점알림과 달리 원치 않는 유저가 많을 수 있어
-- 기존 row/신규 유저 모두 꺼진 상태로 시작, 마이페이지에서 켠 유저에게만 발송.
ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS my_team_concede BOOLEAN NOT NULL DEFAULT false;
