-- 새소식(announcements)에 댓글을 붙이기 위한 브리지 포스트 연결
--
-- 댓글 시스템(comments + CommentSheet + 좋아요/대댓글/실시간/운영자삭제)은 전부
-- 커뮤니티 posts(숫자 id) 기반인데 announcements는 별도(UUID) 테이블이라 직접 연결 불가.
-- 발행 시 board_type='announcement' + is_hidden=true 숨김 포스트를 1개 만들어
-- announcements.post_id로 연결하면 기존 댓글 스택을 그대로 재사용할 수 있다.
--
-- 숨김 포스트는 통합 피드 쿼리(board_type in team/player/free + is_hidden<>true)에
-- 절대 걸리지 않으므로 커뮤니티에 노출되지 않는다.

ALTER TABLE announcements
  ADD COLUMN IF NOT EXISTS post_id bigint REFERENCES posts(id) ON DELETE SET NULL;

COMMENT ON COLUMN announcements.post_id IS '댓글용 브리지 포스트 id (board_type=announcement, is_hidden=true). 발행 시 생성/연결.';
