-- 직관 라이브 스토리 댓글 (venue_story_comments)
--
-- 스토리별 짧은 댓글(최대 200자). 스토리는 경기 종료 후 만료 삭제되므로
-- 댓글도 story FK ON DELETE CASCADE 로 함께 정리된다.
-- 접근 계약은 venue_stories 와 동일하게 API route(service_role)가 소유하되,
-- 방어선(defense-in-depth)으로 클라 RLS 정책도 명시한다:
--   SELECT: 미삭제(deleted_at IS NULL) 댓글은 누구나 조회
--   INSERT: 로그인 유저 본인(user_id = auth.uid())만, 200자 제한은 CHECK 로 강제
--   DELETE 계약: 물리 DELETE 대신 soft delete(deleted_at) — 본인은 UPDATE 정책으로
--                자기 댓글만 deleted_at 세팅 가능. 관리자 삭제는 service_role(API)가 수행.

CREATE TABLE IF NOT EXISTS venue_story_comments (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  story_id   BIGINT NOT NULL REFERENCES venue_stories(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content    TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

-- 스토리별 미삭제 댓글 최신순 조회
CREATE INDEX IF NOT EXISTS idx_venue_story_comments_story
  ON venue_story_comments (story_id, created_at DESC)
  WHERE deleted_at IS NULL;

ALTER TABLE venue_story_comments ENABLE ROW LEVEL SECURITY;

-- 미삭제 댓글은 누구나 조회
CREATE POLICY venue_story_comments_select ON venue_story_comments
  FOR SELECT
  USING (deleted_at IS NULL);

-- 로그인 유저 본인 명의로만 작성
CREATE POLICY venue_story_comments_insert ON venue_story_comments
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id AND deleted_at IS NULL);

-- 본인 댓글 soft delete(deleted_at 세팅)만 허용 — content 수정은 API 계약에 없음
CREATE POLICY venue_story_comments_soft_delete ON venue_story_comments
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
