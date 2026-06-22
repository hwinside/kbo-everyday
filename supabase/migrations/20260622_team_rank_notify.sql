-- 팀 순위 변동 알림 (push-notifications-v1 추가 타입, team-rank.ts notifyTeamRankChanges)
-- 1) 토글 컬럼 — 디폴트 on(기존 row/유저 전부 on 유지, 백필 불필요).
ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS team_rank_change BOOLEAN NOT NULL DEFAULT true;

-- 2) 직전(마지막 확정) 순위 저장 — 그날 경기 전부 종료 후 최종순위 확정 시
--    전일 대비 변동을 1회 계산하기 위한 baseline. team_id별 단일 행.
--    settled_date = 그 순위가 확정된 KST 날짜(같은 날 중복 발화 dedup에도 사용).
CREATE TABLE IF NOT EXISTS team_rank_notify_state (
  team_id      INTEGER PRIMARY KEY,
  rank         INTEGER NOT NULL,
  settled_date DATE NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
