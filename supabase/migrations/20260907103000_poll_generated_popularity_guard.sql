-- Fix poll writes after posts.popularity became a STORED generated column.
-- PostgreSQL computes generated values after BEFORE triggers. Comparing the whole
-- NEW row to OLD therefore treats the derived popularity value as an illegal edit.
-- A comment INSERT updates posts.comment_count and rolls back with SQLSTATE 23514;
-- likes and other legitimate poll post updates can fail by the same path.
-- Exclude only the known database-generated field from the existing strict guard.
-- The generation expression, column privileges, immutable fields and poll rules
-- are unchanged. This also restores already-created polls; no row backfill needed.

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
  -- 삼순 3차 NO-GO(P1) 반영 + 배포 블로커 수정 — strict allowlist(컬럼 권한 계층과 결합):
  --   이 트리거는 poll 글의 UPDATE 에서 title/content ‹그리고 운영 카운터/모더레이션 컬럼›
  --   외 어떤 컬럼도 바뀌면 거부한다(미디어·태그·선지참조·board 등 불변). 운영 카운터
  --   (report_count/is_hidden/조회·좋아요·댓글)는 allowlist 에서 제외해 정당한 서버 갱신
  --   (SECURITY DEFINER writer · service_role)은 통과시키되, 작성자(authenticated)의 직접
  --   위조는 트리거가 아닌 **컬럼 레벨 UPDATE 권한(REVOKE)** 로 차단한다(아래 REVOKE 참조).
  --   ‹삼순 3차 P1-1(운영필드 위조)은 컬럼 권한으로 막는다. GUC/ALTER FUNCTION 방식은
  --    Management API 에서 permission denied 로 적용 불가, role 게이트는 트리거가 SECURITY DEFINER
  --    라 current_user 가 항상 owner → 불가. 컬럼 권한이 표준·prod-안전(함수 미건드림)·적용가능.›
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

  -- (b) strict allowlist: title/content/updated_at + 운영 카운터 외 어떤 컬럼도 바뀌면 거부.
  --     미디어·태그·선지참조·board·game_id·hashtags·author_team_id_snapshot·created_at·author_id 불변.
  --     운영 카운터(report_count/is_hidden/조회·좋아요·댓글)는 제외(정당한 writer/service_role 허용,
  --     클라이언트 위조는 컬럼 REVOKE 가 차단). schema-agnostic: 신규 컬럼도 명시 없이 자동 잠김.
  IF (to_jsonb(NEW) - 'title' - 'content' - 'updated_at'
        - 'report_count' - 'is_hidden' - 'click_view_count' - 'impression_view_count'
        - 'like_count' - 'comment_count' - 'popularity')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'title' - 'content' - 'updated_at'
        - 'report_count' - 'is_hidden' - 'click_view_count' - 'impression_view_count'
        - 'like_count' - 'comment_count' - 'popularity') THEN
    RAISE EXCEPTION 'poll post is locked: only title/content editable (options/tags/media/board immutable)'
      USING ERRCODE = 'check_violation';
  END IF;

  -- (c) updated_at 은 DB 서버생성 시각으로 강제 — 클라이언트 제공값을 무시해 위조 불가(삼순 4차 NO-GO).
  --     실제 질문/설명 편집이면 now(), 그외(순수 updated_at 변경 시도 / 운영 카운터 갱신)은 OLD 유지.
  --     → UPDATE ... SET title='x', updated_at='위조' 이면 title 은 persist하되 updated_at 은 now(),
  --       UPDATE ... SET updated_at='위조'(title/content 미변)은 OLD 유지(위조값 미반영).
  IF NEW.title IS DISTINCT FROM OLD.title OR NEW.content IS DISTINCT FROM OLD.content THEN
    NEW.updated_at := now();
  ELSE
    NEW.updated_at := OLD.updated_at;
  END IF;

  RETURN NEW;
END;
$$;
