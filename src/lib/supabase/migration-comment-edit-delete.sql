-- Migration: 댓글/게시글 수정·삭제 기능 (v1)
-- 2026-04-20
-- 작성자: 삼식이
--
-- 변경사항:
--   [comments]
--   1. updated_at 컬럼 추가 ("수정됨" 표시용)
--   2. 본인 댓글 UPDATE 정책 추가
--   3. 본인 댓글 DELETE 정책 추가
--
--   [posts]
--   4. updated_at 컬럼 추가
--   5. 본인 게시글 DELETE 정책 추가 (UPDATE는 이미 schema.sql에 존재)
--
-- 참고:
--   - functions.sql의 update_comment_count 트리거가 이미 INSERT/DELETE 양쪽 처리 중
--     → 댓글/게시글 삭제 시 comment_count 자동 감소 (posts 삭제 시는 CASCADE로 comments 삭제)

-- === comments ===
ALTER TABLE comments
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

DROP POLICY IF EXISTS "Authors update own comments" ON comments;
CREATE POLICY "Authors update own comments" ON comments
  FOR UPDATE USING (auth.uid() = author_id)
  WITH CHECK (auth.uid() = author_id);

DROP POLICY IF EXISTS "Authors delete own comments" ON comments;
CREATE POLICY "Authors delete own comments" ON comments
  FOR DELETE USING (auth.uid() = author_id);

-- === posts ===
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

DROP POLICY IF EXISTS "Authors delete own posts" ON posts;
CREATE POLICY "Authors delete own posts" ON posts
  FOR DELETE USING (auth.uid() = author_id);
