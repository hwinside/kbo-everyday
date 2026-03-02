-- 신고 테이블
CREATE TABLE reports (
  id BIGSERIAL PRIMARY KEY,
  reporter_id UUID REFERENCES profiles(id),
  target_type TEXT NOT NULL, -- 'post' | 'comment' | 'chat'
  target_id BIGINT NOT NULL,
  reason TEXT NOT NULL, -- 'spam' | 'abuse' | 'sexual' | 'ads' | 'other'
  detail TEXT,
  status TEXT DEFAULT 'pending', -- 'pending' | 'accepted' | 'rejected'
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(reporter_id, target_type, target_id)
);
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users create reports" ON reports FOR INSERT WITH CHECK (auth.uid() = reporter_id);
CREATE POLICY "Users read own reports" ON reports FOR SELECT USING (auth.uid() = reporter_id);

-- posts에 블라인드 컬럼
ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN DEFAULT false;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS report_count INT DEFAULT 0;

-- comments에 블라인드 컬럼
ALTER TABLE comments ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN DEFAULT false;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS report_count INT DEFAULT 0;

-- 자동 블라인드 함수 (신고 3회 → 자동 숨김)
CREATE OR REPLACE FUNCTION auto_blind_on_report()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.target_type = 'post' THEN
    UPDATE posts SET report_count = report_count + 1 WHERE id = NEW.target_id;
    UPDATE posts SET is_hidden = true WHERE id = NEW.target_id AND report_count >= 3;
  ELSIF NEW.target_type = 'comment' THEN
    UPDATE comments SET report_count = report_count + 1 WHERE id = NEW.target_id;
    UPDATE comments SET is_hidden = true WHERE id = NEW.target_id AND report_count >= 3;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_auto_blind
AFTER INSERT ON reports
FOR EACH ROW EXECUTE FUNCTION auto_blind_on_report();
