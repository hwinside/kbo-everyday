-- 시즌 예측 테이블
CREATE TABLE season_predictions (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  season INT NOT NULL DEFAULT 2026,
  category TEXT NOT NULL,
  pick TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, season, category)
);
ALTER TABLE season_predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone reads" ON season_predictions FOR SELECT USING (true);
CREATE POLICY "Users create own" ON season_predictions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own" ON season_predictions FOR UPDATE USING (auth.uid() = user_id);
CREATE INDEX idx_sp_user ON season_predictions(user_id);
CREATE INDEX idx_sp_category ON season_predictions(category);

-- 시즌 예측 집계 뷰
CREATE OR REPLACE VIEW prediction_stats AS
SELECT category, pick, COUNT(*) as vote_count
FROM season_predictions
WHERE season = 2026
GROUP BY category, pick
ORDER BY vote_count DESC;
