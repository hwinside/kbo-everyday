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
  -- 정규화 동일내용 반복 차단 비교 키(normalizeForFloodKey 결과). 화면 노출 금지 — 비교 전용.
  -- route 가 INSERT 시 계산해 RPC 로 전달한다(SQL 에서 JS 정규화를 재현하지 않기 위함).
  content_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

-- 스토리별 미삭제 댓글 최신순 조회
CREATE INDEX IF NOT EXISTS idx_venue_story_comments_story
  ON venue_story_comments (story_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- 유저 최근 댓글 조회(rate/동일내용 판정)용 — soft delete 행도 rate 판정에 포함되므로
-- (삭제로 rate 리셋 불가 계약) 부분 인덱스가 아니라 전체 인덱스여야 판정 쿼리를 커버한다.
CREATE INDEX IF NOT EXISTS idx_venue_story_comments_user_recent
  ON venue_story_comments (user_id, created_at DESC);

-- 클라 직접 접근 0 — RLS 활성화하되 정책은 두지 않는다(venue_stories 동일, service_role 전용).
ALTER TABLE venue_story_comments ENABLE ROW LEVEL SECURITY;

-- 댓글 작성 원자화 RPC(삼순 #807 라운드3 blocker 1) — SELECT 후 INSERT 를 별도 요청으로
-- 하면 같은 유저의 동시 POST 둘이 같은 빈 snapshot 을 읽고 둘 다 통과한다.
-- 유저별 advisory xact lock 으로 직렬화한 뒤 (1) 스토리 active+미만료 게이트
-- (2) 10초 간격 / 60초 내 3건 rate (3) 정규화 키 기준 최근 5건 동일내용 반복 판정
-- (4) INSERT 를 단일 트랜잭션 안에서 수행한다. 판정 상수/경계는
-- src/lib/venue-stories/comments.ts 의 evaluateCommentAbuse(참조 구현)와 동일:
-- now-last < 10s 차단(정확히 10s 는 허용), 60s 창 내 3건 이상 차단, 최근 5건 dup 차단.
CREATE OR REPLACE FUNCTION venue_story_comment_post(
  p_story_id BIGINT,
  p_user_id UUID,
  p_content TEXT,
  p_content_key TEXT
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_last TIMESTAMPTZ;
  v_window_count INT;
  v_dup BOOLEAN;
  v_row venue_story_comments%ROWTYPE;
BEGIN
  IF p_content IS NULL OR char_length(btrim(p_content)) = 0 OR char_length(p_content) > 200
     OR p_content_key IS NULL OR p_user_id IS NULL OR p_story_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid');
  END IF;

  -- 같은 유저의 동시 POST 직렬화 — 트랜잭션 종료 시 자동 해제
  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text));

  -- 수명주기 게이트: active + 미만료 스토리만 (route 의 loadOpenStory 와 동일 계약)
  IF NOT EXISTS (
    SELECT 1 FROM venue_stories
    WHERE id = p_story_id AND status = 'active' AND expires_at > v_now
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  -- rate: 10초 간격 (soft delete 포함 — 삭제로 rate 리셋 불가)
  SELECT max(created_at) INTO v_last
    FROM venue_story_comments WHERE user_id = p_user_id;
  IF v_last IS NOT NULL AND v_last > v_now - INTERVAL '10 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate');
  END IF;

  -- rate: 슬라이딩 윈도우 60초 내 3건
  SELECT count(*) INTO v_window_count
    FROM venue_story_comments
    WHERE user_id = p_user_id AND created_at > v_now - INTERVAL '60 seconds';
  IF v_window_count >= 3 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate');
  END IF;

  -- 정규화 키 기준 최근 5건 동일내용 반복 차단
  SELECT EXISTS (
    SELECT 1 FROM (
      SELECT content_key FROM venue_story_comments
      WHERE user_id = p_user_id
      ORDER BY created_at DESC
      LIMIT 5
    ) recent WHERE recent.content_key = p_content_key
  ) INTO v_dup;
  IF v_dup THEN
    RETURN jsonb_build_object('ok', false, 'error', 'duplicate');
  END IF;

  INSERT INTO venue_story_comments (story_id, user_id, content, content_key)
  VALUES (p_story_id, p_user_id, p_content, p_content_key)
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('ok', true, 'comment', jsonb_build_object(
    'id', v_row.id,
    'story_id', v_row.story_id,
    'user_id', v_row.user_id,
    'content', v_row.content,
    'created_at', v_row.created_at
  ));
END;
$$;

-- RPC 도 service_role 전용 — 클라 롤 실행 차단(테이블 RLS 계약과 동일)
REVOKE ALL ON FUNCTION venue_story_comment_post(BIGINT, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION venue_story_comment_post(BIGINT, UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION venue_story_comment_post(BIGINT, UUID, TEXT, TEXT) FROM authenticated;
-- service_role 실행권한을 migration에서 명시적으로 고정 (소유자/기본권한 의존 금지 — 삼순 #807 라운드4)
GRANT EXECUTE ON FUNCTION venue_story_comment_post(BIGINT, UUID, TEXT, TEXT) TO service_role;
