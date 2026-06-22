-- 팀 순위 변동 알림 (push-notifications-v1 추가 타입, team-rank.ts notifyTeamRankChanges)
-- 1) 토글 컬럼 — 디폴트 on(기존 row/유저 전부 on 유지, 백필 불필요).
ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS team_rank_change BOOLEAN NOT NULL DEFAULT true;

-- 2) 마지막 *발송* 순위 저장 — 순위가 바뀐 순간(옵션 A) 즉시 발화하기 위한 baseline.
--    현재 순위가 이 값과 다르면 발송 후 갱신. team_id별 단일 행.
CREATE TABLE IF NOT EXISTS team_rank_notify_state (
  team_id    INTEGER PRIMARY KEY,
  rank       INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
