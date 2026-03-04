-- YouTube 하이라이트 캐시 테이블
CREATE TABLE IF NOT EXISTS highlights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team TEXT NOT NULL,
  video_id TEXT NOT NULL,
  title TEXT NOT NULL,
  thumbnail TEXT,
  channel TEXT,
  published_at TIMESTAMPTZ,
  fetched_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(team, video_id)
);

CREATE INDEX IF NOT EXISTS idx_highlights_team_date ON highlights(team, published_at DESC);

-- 오래된 영상 자동 정리 (30일 이상)
-- Supabase pg_cron으로 설정 가능

-- 팀별 스타선수 캐시 (KBO 스탯 기반 자동 갱신)
CREATE TABLE IF NOT EXISTS team_stars (
  team TEXT PRIMARY KEY,
  players JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- RLS
ALTER TABLE highlights ENABLE ROW LEVEL SECURITY;
CREATE POLICY "highlights_read" ON highlights FOR SELECT USING (true);
CREATE POLICY "highlights_insert" ON highlights FOR INSERT WITH CHECK (true);
CREATE POLICY "highlights_delete" ON highlights FOR DELETE USING (true);

ALTER TABLE team_stars ENABLE ROW LEVEL SECURITY;
CREATE POLICY "team_stars_read" ON team_stars FOR SELECT USING (true);
CREATE POLICY "team_stars_upsert" ON team_stars FOR ALL USING (true);
