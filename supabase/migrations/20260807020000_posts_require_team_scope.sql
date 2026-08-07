-- 게시글 공개범위 필수 조건을 DB 경계로 못박는다 (하린아빠 2026-08-06 "게시글은 무조건 하나 이상의 팀을 태그해야 함").
--
-- 왜 DB 인가:
--   일반글·사진글은 `createPost()` 가 브라우저에서 supabase-js 로 posts 에 **직접 INSERT** 한다.
--   서버 route 를 거치지 않으므로 API 가드를 둘 자리가 없고, 클라이언트 버튼 disabled 는
--   콘솔에서 supabase.from("posts").insert(...) 한 줄이면 우회된다.
--   → 우회 불가능한 유일한 지점이 DB 다 (삼순 NO-GO 2026-08-06).
--
-- ⚠️ **board_type 면제는 두지 않는다** (삼순 NO-GO 2026-08-07, 실측 확인):
--   직전 판본은 stadium/announcement/news 를 면제했다. 그런데 posts 의 INSERT RLS 는
--   `Auth users create` = WITH CHECK (auth.uid() = author_id) 하나뿐이고 role 제한도 없다
--   (Production pg_policy 실측). 즉 board_type 은 **공격자가 고르는 값**이라, 일반 로그인
--   사용자가 콘솔에서 `board_type:'stadium'` + `team_tags:[]` 로 INSERT 하면 면제를 그대로
--   타고 무태그 글이 저장된다. "신설 board_type 대비 fail-close" 라고 설명했지만 정작
--   **면제 목록 자체가 우회로**였다.
--   → 면제 0개. 모든 글이 canonical 구단 slug 1개 이상을 가져야 한다. 예외 없음 = 우회 지점 없음.
--   면제가 필요했던 글들은 *쓰는 쪽*에서 태그를 채운다(우회 가능한 DB 면제가 아니라, 데이터 생산):
--     · 구장 좌석팁·후기 → 그 구장의 홈팀(`stadiums.ts` teamIds. 잠실이면 LG·두산 2팀)
--     · announcement/news 브릿지 → 10팀 전부(= 전체구단 공개). 어차피 is_hidden=true 라 피드 비노출.
--
-- 무엇을 검사하나 — **canonical KBO 구단 slug 가 1개 이상** (삼순 NO-GO 2026-08-06 2차):
--   배열 길이만 보면 `['']`·`['not-a-team']`·`['{}']` 같은 쓰레기 값이 통과한다. 그러면
--   DB 는 통과했는데 화면(`getTeamBySlug`)은 그 slug 를 못 찾아 팀 0개로 접혀
--   "전체구단 공개"로 표시된다 — 즉 **가드를 통과한 채로 스펙이 깨진다**.
--   그래서 여기서 실제 구단 slug 집합과 대조한다.
--   집합은 `src/lib/constants/teams.ts` 의 TEAMS(10구단, 올스타 제외)와 동일해야 하며,
--   그 exact 일치는 게이트(`qa:post-scope-db-trigger`)가 양방향으로 검증한다.
--   올스타(allstar-nanum/allstar-dream)는 정규 구단이 아니라 `getTeamBySlug` 가 못 찾으므로
--   여기서도 제외한다 — 앱과 DB 판정이 갈리면 안 된다.
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
DECLARE
  v_tags      jsonb;
  v_canonical int;
BEGIN
  -- jsonb 배열 / text[] 양쪽 스키마를 모두 견디게 jsonb 로 정규화한다.
  v_tags := to_jsonb(NEW.team_tags);
  IF v_tags IS NULL OR jsonb_typeof(v_tags) <> 'array' THEN
    RAISE EXCEPTION 'post requires at least one canonical KBO team tag (public scope)'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO v_canonical
  FROM jsonb_array_elements_text(v_tags) AS t(slug)
  WHERE t.slug IN (
    'lg', 'doosan', 'kt', 'ssg', 'nc', 'kia', 'lotte', 'samsung', 'hanwha', 'kiwoom'
  );

  IF v_canonical = 0 THEN
    RAISE EXCEPTION 'post requires at least one canonical KBO team tag (public scope)'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_posts_require_team_scope_trg ON public.posts;
CREATE TRIGGER a_posts_require_team_scope_trg
  BEFORE INSERT ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.posts_require_team_scope();
