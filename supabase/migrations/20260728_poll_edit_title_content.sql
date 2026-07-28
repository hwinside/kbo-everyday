-- 커뮤니티 투표(Poll) 편집 정책 완화 + 서버측 계약 강제 (2026-07-28, rework)
--
-- 배경: 하린아빠 결정(#product) — 투표글의 "제목(질문)·설명"은 수정 가능하게,
-- "선지·마감"은 첫 투표 후 잠금 유지(표 무결성). 기존 20260727_community_poll.sql 의
-- poll_posts_edit_lock() 은 첫 투표(first_vote_at) 후 title/content 도 불변으로 못박아
-- UI 수정 진입점을 열어도 DB 에서 23514(check_violation)로 거부됐다.
--
-- 삼순 NO-GO 반영: "질문·설명만 수정" 계약을 클라이언트가 아니라 DB(트리거)에서 강제한다.
--   · 기존 초안은 첫 투표 후 board_type/board_id/team_tags/player_tags 만 비교해,
--     authenticated 작성자가 직접 SDK UPDATE 로 content_type/image_urls/video_urls/seat_info
--     를 바꿀 수 있었다(voted poll 무결성 훼손 — PG17+RLS probe 로 재현됨).
--   · 이 마이그레이션은 poll_posts_edit_lock() 을 재정의해:
--       (a) poll 글 UPDATE 는 항상 title 필수(빈 질문 금지) + title<=200 + content<=2000 검증
--           → 서버 route 우회(직접 SDK)로도 빈/과길이 질문·설명 저장 불가.
--       (b) 첫 투표 후에는 board_type/board_id/team_tags/player_tags **및**
--           content_type/image_urls/video_urls/seat_info 를 전부 불변화
--           → 작성자 제어 필드 중 title/content 만 수정 가능. 운영 카운터·블라인드 등
--             본 목록에 없는 컬럼(like_count/comment_count/조회수/is_blinded/updated_at 등)은
--             그대로 허용(운영 갱신 무영향).
--   · 선지 구조(poll_options)·마감(poll_polls.closes_at)·allow_multiple 잠금은
--     poll_options_edit_lock()/poll_polls_edit_lock() 트리거가 그대로 담당(무변경).
--   · board_type/board_id 이동(poll→free 2-step 우회)은 첫 투표 여부와 무관하게 계속 차단.
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

  -- 여기부터는 poll 글의 UPDATE(poll_polls 행 존재). 첫 투표 여부와 무관하게
  -- "질문·설명만 수정" 계약을 전 생애주기에 강제한다(삼순 지적: pre-vote 비텍스트 개방 차단).

  -- (a) poll 글의 title/content 유효성을 DB 에서 강제(서버 route 우회 방어).
  --     생성 계약(create_poll)과 동일하게 질문 필수 + 길이 상한.
  IF NEW.title IS NULL OR btrim(NEW.title) = '' THEN
    RAISE EXCEPTION 'poll question(title) is required'
      USING ERRCODE = 'check_violation';
  END IF;
  IF char_length(NEW.title) > 200 THEN
    RAISE EXCEPTION 'poll question(title) exceeds 200 chars'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.content IS NOT NULL AND char_length(NEW.content) > 2000 THEN
    RAISE EXCEPTION 'poll content exceeds 2000 chars'
      USING ERRCODE = 'check_violation';
  END IF;

  -- (b) 첫 투표 후 잠금 — **allowlist** 방식(삼순 NO-GO 반영, denylist → allowlist).
  --     작성자가 직접 UPDATE 로 바꿀 수 있는 필드는 title/content 만 허용하고,
  --     그 외 모든 컬럼(현재 스키마 + 향후 추가될 game_id/hashtags/author_team_id_snapshot/
  --     created_at 등 전부)은 불변이어야 한다. 단, 서버(service_role/SECURITY DEFINER)가
  --     수행하는 운영 갱신(신고 카운터·자동 블라인드·조회/좋아요/댓글 카운터·updated_at)은
  --     허용해야 하므로 이 키들만 allowlist 에서 제외하고 나머지 jsonb 전체를 비교한다.
  --     → schema-agnostic: 새 컬럼이 추가돼도 allowlist 에 명시하지 않는 한 자동으로 잠긴다.
  --     첫 투표 전·후 모두 적용(poll 글은 create_poll RPC 만 선지·태그·미디어를 쓰므로
  --     작성자 직접 UPDATE 로는 title/content 외 어떠한 필드도 바뀜 수 없다).
  --     board_type/board_id 이동(2-step 우회)은 위 GUC 가드 + allowlist 이중으로 차단.
  -- 작성자 편집 허용(title/content) + 서버 운영 갱신(카운터·블라인드·updated_at) 키를
  -- 양쪽 jsonb 에서 제거한 뒤 나머지가 완전 동일해야 통과. 하나라도 다르면 거부.
  IF (to_jsonb(NEW)
        - 'title' - 'content' - 'updated_at'
        - 'report_count' - 'is_hidden'
        - 'click_view_count' - 'impression_view_count'
        - 'like_count' - 'comment_count')
     IS DISTINCT FROM
     (to_jsonb(OLD)
        - 'title' - 'content' - 'updated_at'
        - 'report_count' - 'is_hidden'
        - 'click_view_count' - 'impression_view_count'
        - 'like_count' - 'comment_count') THEN
    RAISE EXCEPTION 'poll post is locked: only title/content editable (options/tags/media/board immutable)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
