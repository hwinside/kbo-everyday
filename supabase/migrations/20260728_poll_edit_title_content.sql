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
        - 'like_count' - 'comment_count')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'title' - 'content' - 'updated_at'
        - 'report_count' - 'is_hidden' - 'click_view_count' - 'impression_view_count'
        - 'like_count' - 'comment_count') THEN
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

-- ── 작성자(클라이언트)의 운영 컬럼 직접 UPDATE 차단 = 컬럼 레벨 REVOKE ──────────────
-- 삼순 3차 P1-1(작성자가 report_count/is_hidden/조회·좋아요·댓글 직접 위조)을 표준 PG 컬럼
-- 권한으로 막는다. 이 컬럼들은 오직 SECURITY DEFINER 트리거/RPC(update_like_count ·
-- update_comment_count · auto_blind_on_report · increment_post_view; 전부 함수 owner 권한으로
-- 실행)만 갱신하므로, 클라이언트 role 의 직접 UPDATE 권한은 회수해도 정상 경로 무영향.
-- (title/content/image_urls/seat_info/updated_at 등 편집 컬럼 권한은 유지 → 편집 경로 무변경.)
-- posts 전체 범위(poll 포함 모든 글)에 적용되는 방어 심층 강화. service_role(서버 전용)은 유지.
-- ⚠️ PostgreSQL 의미: 테이블 레벨 UPDATE 권한은 모든 컬럼을 커버하므로 컬럼 REVOKE 만으로는
-- 제한되지 않는다. 따라서 테이블 UPDATE 를 회수하고 **비운영 컬럼만** 동적으로 GRANT 한다
-- (스키마 드리프에도 견고: 신규 비운영 컬럼은 자동 포함, 운영 컬럼은 자동 제외). service_role·owner 는 미변경.
DO $$
DECLARE v_cols text;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='posts' AND column_name='report_count') THEN
    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
      INTO v_cols
      FROM information_schema.columns
     WHERE table_schema='public' AND table_name='posts'
       AND column_name NOT IN ('report_count','is_hidden','click_view_count',
                               'impression_view_count','like_count','comment_count');
    -- 테이블 레벨 UPDATE 회수 후 비운영 컬럼만 재부여(authenticated). anon 은 편집 불가 → 회수만.
    EXECUTE 'REVOKE UPDATE ON public.posts FROM authenticated';
    EXECUTE 'REVOKE UPDATE ON public.posts FROM anon';
    EXECUTE 'GRANT UPDATE (' || v_cols || ') ON public.posts TO authenticated';
  END IF;
END $$;
