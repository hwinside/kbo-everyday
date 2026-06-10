-- 푸시 알림 v1 — S2: 알림 종류별 on/off 설정
-- row 없음 = 디폴트(전부 on, 이닝 묶음 요약만 off) — 첫 토글 변경 시 upsert.
-- 디스패처(S3+)는 left join + coalesce(컬럼, 디폴트)로 필터.

CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  game_start BOOLEAN NOT NULL DEFAULT true,
  game_end BOOLEAN NOT NULL DEFAULT true,
  my_team_score BOOLEAN NOT NULL DEFAULT true,
  my_team_score_inning_summary BOOLEAN NOT NULL DEFAULT false,
  fav_player_highlight BOOLEAN NOT NULL DEFAULT true,
  fav_player_strikeout BOOLEAN NOT NULL DEFAULT true,
  fav_player_post BOOLEAN NOT NULL DEFAULT true,
  comment_reply BOOLEAN NOT NULL DEFAULT true,
  dm BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE notification_prefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own notification prefs" ON notification_prefs;
CREATE POLICY "Users read own notification prefs" ON notification_prefs
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users insert own notification prefs" ON notification_prefs;
CREATE POLICY "Users insert own notification prefs" ON notification_prefs
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users update own notification prefs" ON notification_prefs;
CREATE POLICY "Users update own notification prefs" ON notification_prefs
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
