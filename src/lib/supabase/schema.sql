-- ===== 크보 에브리데이 Supabase Schema =====

-- 1. 유저 프로필 (Supabase Auth 연동)
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL,
  team_id INT NOT NULL,
  favorite_players JSONB DEFAULT '[]',
  points INT DEFAULT 0,
  grade TEXT DEFAULT 'rookie',
  avatar_url TEXT,
  show_shorts BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public profiles" ON profiles FOR SELECT USING (true);
CREATE POLICY "Users update own" ON profiles FOR UPDATE USING (auth.uid() = id);

-- 2. 게시글
CREATE TABLE posts (
  id BIGSERIAL PRIMARY KEY,
  author_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  board_type TEXT NOT NULL DEFAULT 'team', -- team, player, free
  board_id TEXT NOT NULL, -- teamId or playerId
  content_type TEXT NOT NULL DEFAULT 'general', -- general, photo
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  image_urls JSONB DEFAULT '[]',
  like_count INT DEFAULT 0,
  comment_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ
);
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read posts" ON posts FOR SELECT USING (true);
CREATE POLICY "Auth users create" ON posts FOR INSERT WITH CHECK (auth.uid() = author_id);
CREATE POLICY "Authors update own" ON posts FOR UPDATE USING (auth.uid() = author_id);
CREATE POLICY "Authors delete own posts" ON posts FOR DELETE USING (auth.uid() = author_id);

-- 3. 댓글
CREATE TABLE comments (
  id BIGSERIAL PRIMARY KEY,
  post_id BIGINT REFERENCES posts(id) ON DELETE CASCADE,
  author_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ
);
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read" ON comments FOR SELECT USING (true);
CREATE POLICY "Auth users create" ON comments FOR INSERT WITH CHECK (auth.uid() = author_id);
CREATE POLICY "Authors update own comments" ON comments FOR UPDATE USING (auth.uid() = author_id) WITH CHECK (auth.uid() = author_id);
CREATE POLICY "Authors delete own comments" ON comments FOR DELETE USING (auth.uid() = author_id);

-- 4. 좋아요
CREATE TABLE likes (
  id BIGSERIAL PRIMARY KEY,
  post_id BIGINT REFERENCES posts(id) ON DELETE CASCADE,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(post_id, user_id)
);
ALTER TABLE likes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read" ON likes FOR SELECT USING (true);
CREATE POLICY "Auth users toggle" ON likes FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users delete own" ON likes FOR DELETE USING (auth.uid() = user_id);

-- 5. 승부예측
CREATE TABLE predictions (
  id BIGSERIAL PRIMARY KEY,
  game_id TEXT NOT NULL,
  question TEXT NOT NULL,
  options JSONB NOT NULL, -- [{id, label, teamId?}]
  status TEXT DEFAULT 'open', -- open, closed, resolved
  correct_option TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  closes_at TIMESTAMPTZ
);
ALTER TABLE predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read" ON predictions FOR SELECT USING (true);

-- 6. 예측 투표
CREATE TABLE prediction_votes (
  id BIGSERIAL PRIMARY KEY,
  prediction_id BIGINT REFERENCES predictions(id) ON DELETE CASCADE,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL,
  points_earned INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(prediction_id, user_id)
);
ALTER TABLE prediction_votes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read" ON prediction_votes FOR SELECT USING (true);
CREATE POLICY "Auth users vote" ON prediction_votes FOR INSERT WITH CHECK (auth.uid() = user_id);

-- 7. 채팅 메시지
CREATE TABLE chat_messages (
  id BIGSERIAL PRIMARY KEY,
  room_id TEXT NOT NULL, -- "game:{gameId}:{home|away|all}" or "team:{teamId}"
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read" ON chat_messages FOR SELECT USING (true);
CREATE POLICY "Auth users send" ON chat_messages FOR INSERT WITH CHECK (auth.uid() = user_id);

-- 인덱스
CREATE INDEX idx_posts_board ON posts(board_type, board_id, created_at DESC);
CREATE INDEX idx_comments_post ON comments(post_id, created_at);
CREATE INDEX idx_chat_room ON chat_messages(room_id, created_at DESC);
CREATE INDEX idx_predictions_status ON predictions(status, created_at DESC);
CREATE INDEX idx_prediction_votes_pred ON prediction_votes(prediction_id);
