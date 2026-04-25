-- 2차 댓글 개편: 대댓글(2depth) + 댓글 좋아요
-- 실행: Supabase SQL Editor에서 수동 실행

-- 1. comments 테이블에 parent_id + like_count 추가
ALTER TABLE comments ADD COLUMN IF NOT EXISTS parent_id BIGINT REFERENCES comments(id) ON DELETE CASCADE;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS like_count INT DEFAULT 0;

-- parent_id 인덱스 (대댓글 조회 성능)
CREATE INDEX IF NOT EXISTS idx_comments_parent_id ON comments(parent_id);

-- 2. comment_likes 테이블 생성
CREATE TABLE IF NOT EXISTS comment_likes (
  comment_id BIGINT REFERENCES comments(id) ON DELETE CASCADE,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (comment_id, user_id)
);

-- RLS 활성화
ALTER TABLE comment_likes ENABLE ROW LEVEL SECURITY;

-- 읽기: 누구나
CREATE POLICY "Anyone can read comment likes" ON comment_likes FOR SELECT USING (true);

-- 생성: 인증된 사용자, 본인만
CREATE POLICY "Auth users create comment likes" ON comment_likes FOR INSERT WITH CHECK (auth.uid() = user_id);

-- 삭제: 본인만
CREATE POLICY "Users delete own comment likes" ON comment_likes FOR DELETE USING (auth.uid() = user_id);

-- 3. comment_likes 카운트 트리거
CREATE OR REPLACE FUNCTION update_comment_like_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE comments SET like_count = like_count + 1 WHERE id = NEW.comment_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE comments SET like_count = like_count - 1 WHERE id = OLD.comment_id;
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_comment_like_change ON comment_likes;
CREATE TRIGGER on_comment_like_change
  AFTER INSERT OR DELETE ON comment_likes
  FOR EACH ROW EXECUTE FUNCTION update_comment_like_count();
