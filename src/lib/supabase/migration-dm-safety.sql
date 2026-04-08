-- 유저 차단
CREATE TABLE IF NOT EXISTS user_blocks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  blocker_id UUID NOT NULL REFERENCES auth.users(id),
  blocked_id UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(blocker_id, blocked_id)
);

-- DM 신고
CREATE TABLE IF NOT EXISTS dm_reports (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  reporter_id UUID NOT NULL REFERENCES auth.users(id),
  reported_user_id UUID NOT NULL REFERENCES auth.users(id),
  conversation_id UUID REFERENCES dm_conversations(id),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON user_blocks(blocker_id);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id);
CREATE INDEX IF NOT EXISTS idx_dm_reports_reporter ON dm_reports(reporter_id);

-- RLS
ALTER TABLE user_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE dm_reports ENABLE ROW LEVEL SECURITY;

-- user_blocks: 자기 차단만 조회
CREATE POLICY "blocks_select" ON user_blocks FOR SELECT
  USING (auth.uid() = blocker_id);

-- user_blocks: 자기가 차단 생성
CREATE POLICY "blocks_insert" ON user_blocks FOR INSERT
  WITH CHECK (auth.uid() = blocker_id);

-- user_blocks: 자기 차단만 삭제 (해제)
CREATE POLICY "blocks_delete" ON user_blocks FOR DELETE
  USING (auth.uid() = blocker_id);

-- dm_reports: 자기 신고만 INSERT
CREATE POLICY "reports_insert" ON dm_reports FOR INSERT
  WITH CHECK (auth.uid() = reporter_id);

-- dm_reports: 자기 신고 조회 (중복 방지용)
CREATE POLICY "reports_select" ON dm_reports FOR SELECT
  USING (auth.uid() = reporter_id);
