-- 게시글 공개범위 필수 조건을 DB 경계로 못박는다 (하린아빠 2026-08-06 "게시글은 무조건 하나 이상의 팀을 태그해야 함").
--
-- 왜 DB 인가:
--   일반글·사진글은 `createPost()` 가 브라우저에서 supabase-js 로 posts 에 **직접 INSERT** 한다.
--   서버 route 를 거치지 않으므로 API 가드를 둘 자리가 없고, 클라이언트 버튼 disabled 는
--   콘솔에서 supabase.from("posts").insert(...) 한 줄이면 우회된다.
--   → 우회 불가능한 유일한 지점이 DB 다 (삼순 NO-GO 2026-08-06).
--
-- 무엇을 막나:
--   신규 INSERT 에서 team_tags 가 비어 있으면 거절한다. "전체 구단 공개" 는 태그 없음이 아니라
--   **10개 팀 slug 를 모두 담은 글**로 저장되므로(작성 UI 의 '전체 선택'), 빈 배열은 언제나 미선택이다.
--
-- 무엇을 안 막나 (의도적):
--   * UPDATE — 기존 글 수정 경로는 태그를 건드리지 않는다. 여기서 막으면 신고·카운터 UPDATE 까지
--     23514 로 죽는다.
--   * 기존 행 — backfill 하지 않는다. 태그 없는 옛 글은 `post-scope-input` 이 board_type/board_id 로
--     스코프를 복원하고, 그래도 없으면 '전체구단 공개'로 표시된다. 읽기는 이미 안전하다.
--   * 투표글 — create_poll RPC 의 INSERT 도 이 트리거를 탄다. /api/polls 가 명시 teamTags 를
--     먼저 강제하므로 정상 경로는 항상 비어있지 않다. 만약 비어 있다면 그건 막아야 할 상태가 맞다.
--
-- 트리거 순서: 이름을 `a_` 로 시작시켜 poll_posts_edit_lock 보다 먼저 돌게 한다
--   (Postgres 는 같은 타이밍의 트리거를 이름 알파벳 순으로 실행). 공개범위 위반이
--   poll 전용 에러 메시지에 가려지지 않게 하려는 것.

CREATE OR REPLACE FUNCTION public.posts_require_team_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- jsonb 배열 / text[] 양쪽 스키마를 모두 견디게 개수로 판정한다.
  IF NEW.team_tags IS NULL
     OR jsonb_typeof(to_jsonb(NEW.team_tags)) <> 'array'
     OR jsonb_array_length(to_jsonb(NEW.team_tags)) = 0 THEN
    RAISE EXCEPTION 'post requires at least one team tag (public scope)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_posts_require_team_scope_trg ON public.posts;
CREATE TRIGGER a_posts_require_team_scope_trg
  BEFORE INSERT ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.posts_require_team_scope();
