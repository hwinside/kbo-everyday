-- ============================================================
-- 커뮤니티 투표(Poll) — S1 서버 계약 (spec: specs/community-poll.md)
-- ------------------------------------------------------------
-- 스키마 3테이블(poll_polls / poll_options / poll_votes) + 집계 SSOT 함수
-- (poll_recalc) + 트리거(집계 재계산 / 첫투표 후 편집잠금) + 생성/투표 RPC.
--
-- 보안 핵심(§4):
--   - 3테이블 RLS ENABLE + 정책 0개 → anon/authenticated direct 접근 전면 차단.
--     라벨/순서/집계는 전량 route(service-role) 경유. 클라 직접 select 불가.
--   - RPC(create_poll/cast_poll_vote/poll_recalc)는 EXECUTE를 PUBLIC/anon/
--     authenticated에서 REVOKE → 서버(service_role) 전용.
-- 집계 정합(§4.1): poll_votes AFTER INSERT/DELETE statement 트리거가 cascade
--   삭제(계정/글) 후에도 poll_recalc로 캐시(vote_count/voter_count) 재계산.
-- 편집 잠금(§4.2, §10-2): first_vote_at 세팅 후 posts(title/content) 및 poll
--   설정/선지 구조 변경을 DB 트리거로 거부(클라 직접 UPDATE 우회 차단).
--
-- ⚠️ 멱등(IF NOT EXISTS). 운영 DB 직접 적용 금지 — 머지 게이트에서 선적용.
-- ============================================================

-- ------------------------------------------------------------
-- 0) posts.board_type 에 'poll' 허용
--    현재 posts.board_type 에는 CHECK 제약이 없어(자유 text) 'poll' 은 이미
--    허용 상태다. 그럼에도 향후 누군가 board_type CHECK 를 추가했을 때를 대비해,
--    "기존 CHECK 가 있으면" 실데이터 distinct 값 ∪ {'poll'} 로 확장(레거시 값
--    전부 보존, poll 추가). CHECK 가 없으면 no-op.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_conname text;
  v_allowed text;
BEGIN
  SELECT conname INTO v_conname
  FROM pg_constraint
  WHERE conrelid = 'public.posts'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%board_type%'
  LIMIT 1;

  IF v_conname IS NULL THEN
    RETURN; -- CHECK 없음 → 'poll' 이미 허용, 손대지 않음
  END IF;

  IF (
    SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conname = v_conname AND conrelid = 'public.posts'::regclass
  ) ILIKE '%''poll''%' THEN
    RETURN; -- 이미 poll 포함(멱등)
  END IF;

  -- 실제 존재하는 board_type 값(레거시 보존) ∪ 'poll' 로 재구성
  SELECT string_agg(quote_literal(bt), ',') INTO v_allowed
  FROM (
    SELECT DISTINCT board_type AS bt FROM public.posts WHERE board_type IS NOT NULL
    UNION SELECT 'poll'
  ) s;

  EXECUTE format('ALTER TABLE public.posts DROP CONSTRAINT %I', v_conname);
  EXECUTE format('ALTER TABLE public.posts ADD CONSTRAINT %I CHECK (board_type IN (%s))', v_conname, v_allowed);
END $$;

-- ------------------------------------------------------------
-- 1) 테이블
-- ------------------------------------------------------------

-- 1:1 poll 메타 (option_kind 컬럼 없음 — 조합 규칙은 생성 RPC 검증)
CREATE TABLE IF NOT EXISTS public.poll_polls (
  post_id        bigint PRIMARY KEY REFERENCES public.posts(id) ON DELETE CASCADE,
  allow_multiple boolean     NOT NULL DEFAULT false,
  closes_at      timestamptz NOT NULL,                 -- 10분~30일 검증은 create_poll RPC(now 의존)
  voter_count    int         NOT NULL DEFAULT 0,       -- 고유 참여자 수
  first_vote_at  timestamptz NULL,                     -- 최초 투표 시각 → 편집 잠금 판정
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.poll_options (
  id             bigserial PRIMARY KEY,
  post_id        bigint NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  position       int    NOT NULL,
  kind           text   NOT NULL CHECK (kind IN ('team','player','etc')),
  ref_id         text   NULL,                          -- 팀 슬러그/kboId. etc=null. 렌더 SSOT
  label_snapshot text   NULL,                          -- 팀명/선수명 fallback. etc=자유입력 본문
  image_snapshot text   NULL,                          -- 로고/선수사진 fallback
  vote_count     int    NOT NULL DEFAULT 0,            -- 집계 캐시
  CONSTRAINT poll_options_post_id_id_key UNIQUE (post_id, id) -- poll_votes 복합 FK 대상(소속 강제)
);

CREATE TABLE IF NOT EXISTS public.poll_votes (
  id         bigserial PRIMARY KEY,
  post_id    bigint NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  option_id  bigint NOT NULL,
  user_id    uuid   NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 옵션의 post 소속 강제(타 poll 옵션 투표 차단)
  CONSTRAINT poll_votes_option_belongs_fk
    FOREIGN KEY (post_id, option_id) REFERENCES public.poll_options(post_id, id) ON DELETE CASCADE,
  -- 같은 선지 중복 방지
  CONSTRAINT poll_votes_post_user_option_key UNIQUE (post_id, user_id, option_id)
);

CREATE INDEX IF NOT EXISTS poll_options_post_id_idx      ON public.poll_options (post_id);
CREATE INDEX IF NOT EXISTS poll_votes_post_id_idx        ON public.poll_votes (post_id);
CREATE INDEX IF NOT EXISTS poll_votes_post_id_user_idx   ON public.poll_votes (post_id, user_id);

-- ------------------------------------------------------------
-- 2) RLS: 3테이블 ENABLE + 정책 0개 (전면 차단, service-role만 접근)
--    + 테이블 권한도 anon/authenticated/PUBLIC 에서 REVOKE (이중 안전)
-- ------------------------------------------------------------
ALTER TABLE public.poll_polls   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poll_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poll_votes   ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.poll_polls   FORCE ROW LEVEL SECURITY;
ALTER TABLE public.poll_options FORCE ROW LEVEL SECURITY;
ALTER TABLE public.poll_votes   FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.poll_polls, public.poll_options, public.poll_votes FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.poll_polls, public.poll_options, public.poll_votes FROM authenticated;
  END IF;
  REVOKE ALL ON public.poll_polls, public.poll_options, public.poll_votes FROM PUBLIC;
END $$;

-- ------------------------------------------------------------
-- 3) 집계 SSOT 함수 (§10-1: poll-row lock 획득 후 별도 statement 재계산)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.poll_recalc(p_post_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- poll-row lock (동시 재계산 직렬화). lock statement 는 집계와 분리(§10-1).
  PERFORM 1 FROM poll_polls WHERE post_id = p_post_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN; -- poll 이미 삭제(글/계정 cascade) → 재계산 불필요
  END IF;

  -- 옵션별 득표 재계산(무득표 옵션은 0으로 리셋 — LEFT JOIN)
  UPDATE poll_options o
  SET vote_count = agg.cnt
  FROM (
    SELECT o2.id, COUNT(vt.id) AS cnt
    FROM poll_options o2
    LEFT JOIN poll_votes vt ON vt.post_id = o2.post_id AND vt.option_id = o2.id
    WHERE o2.post_id = p_post_id
    GROUP BY o2.id
  ) agg
  WHERE o.id = agg.id AND o.post_id = p_post_id
    AND o.vote_count IS DISTINCT FROM agg.cnt;

  -- 고유 참여자 수
  UPDATE poll_polls p
  SET voter_count = (SELECT COUNT(DISTINCT user_id) FROM poll_votes WHERE post_id = p_post_id)
  WHERE p.post_id = p_post_id
    AND p.voter_count IS DISTINCT FROM (SELECT COUNT(DISTINCT user_id) FROM poll_votes WHERE post_id = p_post_id);
END;
$$;

-- ------------------------------------------------------------
-- 4) poll_votes AFTER INSERT/DELETE statement 트리거 → poll_recalc
--    (transition table 로 cascade 삭제분까지 poll 단위 1회 재계산)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.poll_votes_recalc_stmt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN SELECT DISTINCT post_id FROM new_rows LOOP
      PERFORM public.poll_recalc(r.post_id);
    END LOOP;
  ELSE -- DELETE
    FOR r IN SELECT DISTINCT post_id FROM old_rows LOOP
      PERFORM public.poll_recalc(r.post_id);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS poll_votes_recalc_ins ON public.poll_votes;
CREATE TRIGGER poll_votes_recalc_ins
  AFTER INSERT ON public.poll_votes
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.poll_votes_recalc_stmt();

DROP TRIGGER IF EXISTS poll_votes_recalc_del ON public.poll_votes;
CREATE TRIGGER poll_votes_recalc_del
  AFTER DELETE ON public.poll_votes
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.poll_votes_recalc_stmt();

-- ------------------------------------------------------------
-- 5) 편집 잠금 (§4.2) — posts BEFORE UPDATE.
--    잠금 기준은 board_type 이 아니라 "poll_polls 행 존재 + first_vote_at 세팅".
--    board_type 분기로 판정하면 첫 투표 후 board_type 을 'free' 로 바꾼 뒤
--    (그 UPDATE 는 분기 통과) title 을 바꾸는 2-step 우회가 뚫린다. 그래서
--    poll 소속 여부는 poll_polls(post_id) 로만 판정하고, 잠금 시 board_type·
--    board_id·title·content·team_tags·player_tags 를 전부 불변으로 못박는다
--    (board_type 변경 자체도 잠금 대상 → 우회 진입점 제거).
--    poll_polls 행이 없는 비-poll 글은 즉시 통과(오버헤드 최소).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.poll_posts_edit_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_first timestamptz;
BEGIN
  -- poll 글은 poll_polls 행 존재로 판정(board_type 무관 → 2-step 우회 차단).
  SELECT first_vote_at INTO v_first FROM poll_polls WHERE post_id = OLD.id;
  IF NOT FOUND THEN
    RETURN NEW; -- poll_polls 행 없음 → 비-poll 글 → 통과
  END IF;
  IF v_first IS NOT NULL
     AND (NEW.board_type  IS DISTINCT FROM OLD.board_type
       OR NEW.board_id    IS DISTINCT FROM OLD.board_id
       OR NEW.title       IS DISTINCT FROM OLD.title
       OR NEW.content     IS DISTINCT FROM OLD.content
       OR NEW.team_tags   IS DISTINCT FROM OLD.team_tags
       OR NEW.player_tags IS DISTINCT FROM OLD.player_tags) THEN
    RAISE EXCEPTION 'poll post is locked after first vote (board_type/board_id/title/content/tags immutable)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS poll_posts_edit_lock_trg ON public.posts;
CREATE TRIGGER poll_posts_edit_lock_trg
  BEFORE UPDATE ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.poll_posts_edit_lock();

-- ------------------------------------------------------------
-- 6) 선지 구조 잠금 (§10-2) — poll_options: first_vote_at 세팅 후 INSERT/DELETE
--    및 구조(position/kind/ref_id/label/image/id/post_id) UPDATE 거부.
--    단 집계 캐시(vote_count)만 바뀌는 UPDATE 는 허용(recalc 경로).
--    posts cascade 삭제(부모 posts 행이 이미 사라진 경우)는 허용.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.poll_options_edit_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_post  bigint := COALESCE(NEW.post_id, OLD.post_id);
  v_first timestamptz;
BEGIN
  -- 부모 posts 가 이미 삭제됨 → cascade 삭제 경로 → 허용
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM posts WHERE id = v_post) THEN
    RETURN OLD;
  END IF;

  SELECT first_vote_at INTO v_first FROM poll_polls WHERE post_id = v_post;
  IF v_first IS NULL THEN
    RETURN COALESCE(NEW, OLD); -- 아직 잠금 전
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id       IS DISTINCT FROM OLD.id
       OR NEW.post_id        IS DISTINCT FROM OLD.post_id
       OR NEW.position       IS DISTINCT FROM OLD.position
       OR NEW.kind           IS DISTINCT FROM OLD.kind
       OR NEW.ref_id         IS DISTINCT FROM OLD.ref_id
       OR NEW.label_snapshot IS DISTINCT FROM OLD.label_snapshot
       OR NEW.image_snapshot IS DISTINCT FROM OLD.image_snapshot THEN
      RAISE EXCEPTION 'poll options are locked after first vote (structure immutable)'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW; -- vote_count 만 변경 → 허용
  END IF;

  -- INSERT / (직접) DELETE after first vote → 차단
  RAISE EXCEPTION 'poll options are locked after first vote (no add/remove)'
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS poll_options_edit_lock_trg ON public.poll_options;
CREATE TRIGGER poll_options_edit_lock_trg
  BEFORE INSERT OR UPDATE OR DELETE ON public.poll_options
  FOR EACH ROW EXECUTE FUNCTION public.poll_options_edit_lock();

-- ------------------------------------------------------------
-- 7) poll 설정 잠금 (§10-2) — poll_polls: first_vote_at 세팅 후 allow_multiple/
--    closes_at 변경 거부. first_vote_at 최초 세팅과 voter_count 갱신은 허용.
--    부모 posts cascade 삭제는 허용.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.poll_polls_edit_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM posts WHERE id = OLD.post_id) THEN
      RETURN OLD; -- cascade
    END IF;
    IF OLD.first_vote_at IS NOT NULL THEN
      RAISE EXCEPTION 'poll is locked after first vote (no delete)' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF OLD.first_vote_at IS NOT NULL THEN
    IF NEW.post_id       IS DISTINCT FROM OLD.post_id
       OR NEW.allow_multiple IS DISTINCT FROM OLD.allow_multiple
       OR NEW.closes_at      IS DISTINCT FROM OLD.closes_at
       OR NEW.first_vote_at  IS DISTINCT FROM OLD.first_vote_at THEN
      RAISE EXCEPTION 'poll settings are locked after first vote' USING ERRCODE = 'check_violation';
    END IF;
    -- voter_count 만 변경 → 허용
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS poll_polls_edit_lock_trg ON public.poll_polls;
CREATE TRIGGER poll_polls_edit_lock_trg
  BEFORE UPDATE OR DELETE ON public.poll_polls
  FOR EACH ROW EXECUTE FUNCTION public.poll_polls_edit_lock();

-- ------------------------------------------------------------
-- 8) RPC create_poll — posts+poll_polls+poll_options 단일 트랜잭션 생성
--    p_options: jsonb 배열 [{kind, ref_id, label, image}] (작성순 = 배열순)
--    p_team_tags/p_player_tags: route 가 canonical(teams.ts slug / roster kboId:name)
--      검증·파생해 전달하는 기존 커뮤니티 태그 배열. posts.team_tags/player_tags 에
--      원자적으로 채워 팀·선수 피드에 즉시 노출(etc 옵션은 태그 미반영).
-- ------------------------------------------------------------
-- 시그니처 확장(6→8 args) → 구 6-arg 오버로드 잔존 방지 위해 먼저 DROP(멱등).
DROP FUNCTION IF EXISTS public.create_poll(uuid, text, text, boolean, timestamptz, jsonb);
CREATE OR REPLACE FUNCTION public.create_poll(
  p_author_id     uuid,
  p_title         text,
  p_content       text,
  p_allow_multiple boolean,
  p_closes_at     timestamptz,
  p_options       jsonb,
  p_team_tags     jsonb DEFAULT '[]'::jsonb,
  p_player_tags   jsonb DEFAULT '[]'::jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_post_id   bigint;
  v_count     int;
  v_has_team  boolean;
  v_has_player boolean;
  v_opt       jsonb;
  v_idx       int := 0;
  v_kind      text;
  v_ref       text;
  v_label     text;
  v_now       timestamptz := now();
BEGIN
  IF p_author_id IS NULL THEN
    RAISE EXCEPTION 'author required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_title IS NULL OR btrim(p_title) = '' THEN
    RAISE EXCEPTION 'title required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_closes_at IS NULL THEN
    RAISE EXCEPTION 'closes_at required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_closes_at < v_now + interval '10 minutes' THEN
    RAISE EXCEPTION 'closes_at must be at least 10 minutes from now' USING ERRCODE = 'check_violation';
  END IF;
  IF p_closes_at > v_now + interval '30 days' THEN
    RAISE EXCEPTION 'closes_at must be within 30 days from now' USING ERRCODE = 'check_violation';
  END IF;

  IF jsonb_typeof(p_options) <> 'array' THEN
    RAISE EXCEPTION 'options must be a json array' USING ERRCODE = 'check_violation';
  END IF;
  v_count := jsonb_array_length(p_options);
  IF v_count < 2 OR v_count > 10 THEN
    RAISE EXCEPTION 'poll must have 2..10 options (got %)', v_count USING ERRCODE = 'check_violation';
  END IF;

  -- 팀+선수 공존 금지(기타 혼합 허용)
  SELECT bool_or(elem->>'kind' = 'team'), bool_or(elem->>'kind' = 'player')
    INTO v_has_team, v_has_player
  FROM jsonb_array_elements(p_options) elem;
  IF v_has_team AND v_has_player THEN
    RAISE EXCEPTION 'team and player options cannot coexist in one poll' USING ERRCODE = 'check_violation';
  END IF;

  IF p_team_tags IS NOT NULL AND jsonb_typeof(p_team_tags) <> 'array' THEN
    RAISE EXCEPTION 'team_tags must be a json array' USING ERRCODE = 'check_violation';
  END IF;
  IF p_player_tags IS NOT NULL AND jsonb_typeof(p_player_tags) <> 'array' THEN
    RAISE EXCEPTION 'player_tags must be a json array' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO posts (author_id, board_type, board_id, title, content, team_tags, player_tags, created_at)
  VALUES (p_author_id, 'poll', 'poll', btrim(p_title), COALESCE(NULLIF(btrim(COALESCE(p_content, '')), ''), ''),
          COALESCE(p_team_tags, '[]'::jsonb), COALESCE(p_player_tags, '[]'::jsonb), v_now)
  RETURNING id INTO v_post_id;

  INSERT INTO poll_polls (post_id, allow_multiple, closes_at, created_at)
  VALUES (v_post_id, COALESCE(p_allow_multiple, false), p_closes_at, v_now);

  FOR v_opt IN SELECT * FROM jsonb_array_elements(p_options) LOOP
    v_kind  := v_opt->>'kind';
    v_ref   := NULLIF(v_opt->>'ref_id', '');
    v_label := NULLIF(v_opt->>'label', '');
    IF v_kind IS NULL OR v_kind NOT IN ('team','player','etc') THEN
      RAISE EXCEPTION 'invalid option kind: %', COALESCE(v_kind, '(null)') USING ERRCODE = 'check_violation';
    END IF;
    IF v_kind = 'etc' THEN
      IF v_label IS NULL THEN
        RAISE EXCEPTION 'etc option requires a non-empty label' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF v_ref IS NULL THEN
        RAISE EXCEPTION '% option requires ref_id', v_kind USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    INSERT INTO poll_options (post_id, position, kind, ref_id, label_snapshot, image_snapshot)
    VALUES (v_post_id, v_idx, v_kind, v_ref, v_label, NULLIF(v_opt->>'image', ''));
    v_idx := v_idx + 1;
  END LOOP;

  RETURN v_post_id;
END;
$$;

-- ------------------------------------------------------------
-- 9) RPC cast_poll_vote — 투표/변경 (마감·빈·중복·정책 DB 검증 → 재계산)
--    (post,user) 직렬화: advisory xact lock + poll-row FOR UPDATE.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cast_poll_vote(
  p_post_id   bigint,
  p_user_id   uuid,
  p_option_ids bigint[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_allow_multiple boolean;
  v_closes_at timestamptz;
  v_first     timestamptz;
  v_valid     int;
  v_distinct  int;
  v_now       timestamptz := now();
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_option_ids IS NULL OR array_length(p_option_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'no options selected' USING ERRCODE = 'check_violation';
  END IF;

  -- (post,user) 직렬화
  PERFORM pg_advisory_xact_lock(hashtextextended(p_post_id::text || ':' || p_user_id::text, 0));
  -- poll-row lock (동시 타 유저 투표와 집계 stale 방지)
  SELECT allow_multiple, closes_at, first_vote_at
    INTO v_allow_multiple, v_closes_at, v_first
  FROM poll_polls WHERE post_id = p_post_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'poll not found' USING ERRCODE = 'no_data_found';
  END IF;

  -- 마감 fail-closed (서버 시간 재검증)
  IF v_now >= v_closes_at THEN
    RAISE EXCEPTION 'poll is closed' USING ERRCODE = 'check_violation';
  END IF;

  -- 빈/중복 검증
  SELECT count(*), count(DISTINCT x) INTO v_valid, v_distinct
  FROM unnest(p_option_ids) x WHERE x IS NOT NULL;
  IF v_distinct = 0 THEN
    RAISE EXCEPTION 'no options selected' USING ERRCODE = 'check_violation';
  END IF;
  IF v_distinct <> v_valid THEN
    RAISE EXCEPTION 'duplicate option in selection' USING ERRCODE = 'check_violation';
  END IF;

  -- 단일선택 상한
  IF NOT v_allow_multiple AND v_distinct > 1 THEN
    RAISE EXCEPTION 'single-select poll allows only one option' USING ERRCODE = 'check_violation';
  END IF;

  -- 모든 옵션이 이 poll 소속인지 사전검증(복합 FK도 삽입 시 강제)
  SELECT count(*) INTO v_valid
  FROM (SELECT DISTINCT x FROM unnest(p_option_ids) x WHERE x IS NOT NULL) sel
  JOIN poll_options o ON o.post_id = p_post_id AND o.id = sel.x;
  IF v_valid <> v_distinct THEN
    RAISE EXCEPTION 'option does not belong to this poll' USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- 기존 ballot 삭제 → 신규 삽입 (변경 시 이전표 소멸)
  DELETE FROM poll_votes WHERE post_id = p_post_id AND user_id = p_user_id;
  INSERT INTO poll_votes (post_id, option_id, user_id)
  SELECT p_post_id, sel.x, p_user_id
  FROM (SELECT DISTINCT x FROM unnest(p_option_ids) x WHERE x IS NOT NULL) sel;

  -- first_vote_at 최초 1회 세팅 → 편집 잠금 개시
  IF v_first IS NULL THEN
    UPDATE poll_polls SET first_vote_at = v_now WHERE post_id = p_post_id AND first_vote_at IS NULL;
  END IF;

  -- poll-row lock 하 SSOT 재계산 (트리거와 별개로 명시 호출; 멱등)
  PERFORM public.poll_recalc(p_post_id);
END;
$$;

-- ------------------------------------------------------------
-- 10) RPC EXECUTE 권한 — PUBLIC/anon/authenticated REVOKE, service_role 만 허용
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.poll_recalc(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_poll(uuid, text, text, boolean, timestamptz, jsonb, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cast_poll_vote(bigint, uuid, bigint[]) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.poll_recalc(bigint) FROM anon;
    REVOKE ALL ON FUNCTION public.create_poll(uuid, text, text, boolean, timestamptz, jsonb, jsonb, jsonb) FROM anon;
    REVOKE ALL ON FUNCTION public.cast_poll_vote(bigint, uuid, bigint[]) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.poll_recalc(bigint) FROM authenticated;
    REVOKE ALL ON FUNCTION public.create_poll(uuid, text, text, boolean, timestamptz, jsonb, jsonb, jsonb) FROM authenticated;
    REVOKE ALL ON FUNCTION public.cast_poll_vote(bigint, uuid, bigint[]) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.poll_recalc(bigint) TO service_role;
    GRANT EXECUTE ON FUNCTION public.create_poll(uuid, text, text, boolean, timestamptz, jsonb, jsonb, jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION public.cast_poll_vote(bigint, uuid, bigint[]) TO service_role;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 배포 후 검증(예):
--   SELECT create_poll('<uuid>'::uuid, 'Q?', null, false, now()+interval '1 day',
--     '[{"kind":"team","ref_id":"lg"},{"kind":"team","ref_id":"ob"}]'::jsonb);
--   SELECT cast_poll_vote(<post_id>, '<uuid>'::uuid, ARRAY[<option_id>]);
-- ============================================================
