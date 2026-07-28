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
  PERFORM 1 FROM poll_polls WHERE post_id = OLD.id;
  IF NOT FOUND THEN
    RETURN NEW; -- poll_polls 행 없음 → 비-poll 글 → 통과
  END IF;

  -- 여기부터는 poll 글의 UPDATE(poll_polls 행 존재). 첫 투표 여부와 무관하게
  -- "질문(title)·설명(content)만 작성자 수정" 계약을 전 생애주기에 강제한다.
  --
  -- 삼순 3차 NO-GO(P1) 반영 — denylist/부분 allowlist 폐기, GUC 게이트 strict allowlist:
  --   기존 구현은 운영필드(report_count/is_hidden/조회·좋아요·댓글 카운터/updated_at)를
  --   allowlist 비교에서 무조건 제외했다. 그 결과 authenticated 작성자가 직접 SDK UPDATE 로
  --   이 필드들을 위조할 수 있었다(독립 PG17 `UPDATE 1`). 이제는 title/content/updated_at 을
  --   제외한 "모든" 컬럼(운영필드 포함)을 불변화한다.
  --   운영필드를 갱신하는 정당한 서버 경로(update_like_count / update_comment_count /
  --   auto_blind_on_report / increment_post_view)는 전부 SECURITY DEFINER 함수이며, 이
  --   마이그레이션이 각 함수에 `ALTER FUNCTION ... SET kbo.posts_op='1'` 을 부여한다
  --   (함수 실행 스코프에서만 GUC='1', 종료 시 자동 해제 → drift 0, 트랜잭션 누수 0).
  --   → 그 경로는 아래 잠금을 건너뛰고, GUC 미설정인 작성자 직접 UPDATE 만 잠금 대상.
  IF current_setting('kbo.posts_op', true) IS DISTINCT FROM '1' THEN
    -- (a) title/content 유효성(서버 route 우회 방어) — 생성 계약(create_poll)과 동일.
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

    -- (b) strict allowlist: title/content/updated_at 외 어떤 컬럼도 바뀌면 거부.
    --     운영/모더레이션 카운터(report_count/is_hidden/조회·좋아요·댓글)·미디어·태그·
    --     선지참조·board·game_id·hashtags·author_team_id_snapshot·created_at·author_id 전부 불변.
    --     schema-agnostic: 향후 신규 컬럼도 명시 없이 자동 잠김.
    IF (to_jsonb(NEW) - 'title' - 'content' - 'updated_at')
       IS DISTINCT FROM
       (to_jsonb(OLD) - 'title' - 'content' - 'updated_at') THEN
      RAISE EXCEPTION 'poll post is locked: only title/content editable (moderation/counters/options/tags/media/board immutable)'
        USING ERRCODE = 'check_violation';
    END IF;

    -- (c) updated_at 은 DB 서버생성 시각으로 강제 — 클라이언트 제공값을 무시해 위조 불가(삼순 4차 NO-GO).
    --     실제 질문/설명 편집이면 now(), 그외(순수 updated_at 변경 시도)은 OLD 유지.
    --     → UPDATE ... SET title='x', updated_at='위조' 이면 title 은 persist하되 updated_at 은 now(),
    --       UPDATE ... SET updated_at='위조'(title/content 미변)은 OLD 유지(위조값 미반영).
    IF NEW.title IS DISTINCT FROM OLD.title OR NEW.content IS DISTINCT FROM OLD.content THEN
      NEW.updated_at := now();
    ELSE
      NEW.updated_at := OLD.updated_at;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ── 운영/모더레이션 SECURITY DEFINER writer 에 실행 스코프 GUC 부여 ──────────────
-- poll 글에도 정당한 운영 갱신(좋아요/댓글/조회 카운터, 신고→자동 블라인드)이 발생하므로,
-- 각 writer 실행 중에만 kbo.posts_op='1' 을 세워 위 strict 잠금을 건너뛰게 한다.
-- ALTER FUNCTION ... SET 은 함수 진입 시 GUC 를 설정하고 종료 시 되돌리므로 body 재작성
-- (drift) 없이, 그리고 set_config(is_local) 와 달리 트랜잭션 잔여 없이 정확히 함수 스코프로만
-- 적용된다. 함수가 존재할 때만 ALTER(idempotent, 부분 환경/하네스 안전).
DO $$
BEGIN
  IF to_regprocedure('public.update_like_count()') IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.update_like_count() SET kbo.posts_op = ''1''';
  END IF;
  IF to_regprocedure('public.update_comment_count()') IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.update_comment_count() SET kbo.posts_op = ''1''';
  END IF;
  IF to_regprocedure('public.auto_blind_on_report()') IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.auto_blind_on_report() SET kbo.posts_op = ''1''';
  END IF;
  IF to_regprocedure('public.increment_post_view(bigint, text)') IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.increment_post_view(bigint, text) SET kbo.posts_op = ''1''';
  END IF;
END $$;
