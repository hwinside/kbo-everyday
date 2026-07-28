-- 커뮤니티 투표(Poll) 편집 정책 완화 (2026-07-28)
--
-- 배경: 하린아빠 결정(#product) — 투표글의 "제목(질문)·설명"은 수정 가능하게,
-- "선지·마감"은 첫 투표 후 잠금 유지(표 무결성). 기존 20260727_community_poll.sql 의
-- poll_posts_edit_lock() 은 첫 투표(first_vote_at) 후 title/content 도 불변으로 못박아
-- UI 수정 진입점을 열어도 DB 에서 23514(check_violation)로 거부됐다.
--
-- 이 마이그레이션은 poll_posts_edit_lock() 만 재정의해 **첫 투표 후에도 title/content 는
-- 허용**하고, board_type/board_id/team_tags/player_tags 는 계속 불변으로 유지한다.
--   - 선지 구조(poll_options)·마감(poll_polls.closes_at)·allow_multiple 잠금은
--     poll_options_edit_lock()/poll_polls_edit_lock() 트리거가 그대로 담당(무변경).
--   - team_tags/player_tags 는 선지에서 파생된 값이라 선지가 잠긴 이상 함께 잠금 유지
--     (선지 불변인데 태그만 바뀌면 목록 노출과 어긋남).
--   - board_type/board_id 불변 유지 → 첫 투표 후 poll→free 2-step 우회로 다른 필드를
--     푸는 경로도 계속 차단.
-- INSERT 가드(create_poll 밖 phantom poll INSERT 차단)는 원본 그대로 유지한다.

CREATE OR REPLACE FUNCTION public.poll_posts_edit_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_first timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.board_type = 'poll'
       AND current_setting('kbo.poll_write', true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'poll posts must be created through create_poll'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- board_type/board_id 를 실제로 바꾸는 UPDATE 만 poll 타입 불변 가드 대상.
  -- non-poll→poll·poll→free·board 이동 차단(첫 투표 후 2-step 우회 포함).
  IF (NEW.board_type IS DISTINCT FROM OLD.board_type
       OR NEW.board_id IS DISTINCT FROM OLD.board_id)
     AND (OLD.board_type = 'poll' OR NEW.board_type = 'poll')
     AND current_setting('kbo.poll_write', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'poll posts cannot be written directly'
      USING ERRCODE = 'check_violation';
  END IF;

  -- poll 글은 poll_polls 행 존재로 판정(board_type 무관 → 2-step 우회 차단).
  SELECT first_vote_at INTO v_first FROM poll_polls WHERE post_id = OLD.id;
  IF NOT FOUND THEN
    RETURN NEW; -- poll_polls 행 없음 → 비-poll 글 → 통과
  END IF;
  -- 첫 투표 후 잠금: board_type/board_id/tags 는 불변, **title/content 는 허용**(하린아빠 결정).
  -- 선지·마감 잠금은 poll_options / poll_polls 트리거가 담당.
  IF v_first IS NOT NULL
     AND (NEW.board_type  IS DISTINCT FROM OLD.board_type
       OR NEW.board_id    IS DISTINCT FROM OLD.board_id
       OR NEW.team_tags   IS DISTINCT FROM OLD.team_tags
       OR NEW.player_tags IS DISTINCT FROM OLD.player_tags) THEN
    RAISE EXCEPTION 'poll post is locked after first vote (board_type/board_id/tags immutable; title/content editable)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
