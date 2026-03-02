-- 유저 배지 테이블
CREATE TABLE user_badges (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  badge_id TEXT NOT NULL,
  earned_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, badge_id)
);
ALTER TABLE user_badges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone reads badges" ON user_badges FOR SELECT USING (true);
CREATE POLICY "Users earn badges" ON user_badges FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_badges_user ON user_badges(user_id);

-- 초대 테이블
CREATE TABLE invitations (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  inviter_id UUID REFERENCES profiles(id),
  invitee_id UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  used_at TIMESTAMPTZ
);
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Read own invites" ON invitations FOR SELECT USING (auth.uid() = inviter_id OR auth.uid() = invitee_id);
CREATE POLICY "Create invites" ON invitations FOR INSERT WITH CHECK (auth.uid() = inviter_id);
CREATE POLICY "Use invites" ON invitations FOR UPDATE USING (true);
CREATE INDEX idx_invitations_code ON invitations(code);

-- profiles 컬럼 추가
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS invited_by UUID REFERENCES profiles(id);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_founder BOOLEAN DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS invite_count INT DEFAULT 3;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS show_posts BOOLEAN DEFAULT true;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT '';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS total_posts INT DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS total_comments INT DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS total_likes_received INT DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ DEFAULT now();
