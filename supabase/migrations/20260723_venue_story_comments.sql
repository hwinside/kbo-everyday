-- 직관 라이브 스토리 댓글 (venue_story_comments)
--
-- 스토리별 짧은 댓글(최대 200자). 스토리는 경기 종료 후 만료 삭제되므로
-- 댓글도 story FK ON DELETE CASCADE 로 함께 정리된다.
-- 접근 계약은 venue_stories 와 동일하게 API route(service_role) 전용이다.
-- 클라 RLS 정책은 의도적으로 하나도 만들지 않는다(삼순 #807 blocker 1·2):
--   INSERT 를 열면 클라가 API 밖에서 비활성·만료 스토리 작성·created_at 임의 지정·
--   rate/trim/동일내용 가드를 전부 우회하고, SELECT 를 열면 만료·비활성 스토리의
--   댓글도 route 수명주기 게이트 밖에서 열린다. 조회/작성/soft delete 모두
--   API route 가 active+미만료 검사·어뷰징 가드·권한 검사 후 service_role 로 수행한다.

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

-- 클라 직접 접근 0 — RLS 활성화하되 정책은 두지 않는다(venue_stories 동일, service_role 전용).
ALTER TABLE venue_story_comments ENABLE ROW LEVEL SECURITY;
