-- 직관 스토리 댓글 duplicate 차단을 같은 스토리·5분 내로 제한한다.
-- 기존 함수는 사용자의 전 스토리 최근 5건을 시간 제한 없이 비교해,
-- 과거 다른 스토리에 남긴 흔한 이모지(예: 👍)까지 새 댓글에서 차단했다.

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

  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text));

  IF NOT EXISTS (
    SELECT 1 FROM venue_stories
    WHERE id = p_story_id AND status = 'active' AND expires_at > v_now
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  SELECT max(created_at) INTO v_last
    FROM venue_story_comments WHERE user_id = p_user_id;
  IF v_last IS NOT NULL AND v_last > v_now - INTERVAL '10 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate');
  END IF;

  SELECT count(*) INTO v_window_count
    FROM venue_story_comments
    WHERE user_id = p_user_id AND created_at > v_now - INTERVAL '60 seconds';
  IF v_window_count >= 3 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate');
  END IF;

  -- 재탭/재시도 차단은 같은 스토리의 최근 5분에만 적용한다.
  -- soft delete 행도 포함해 삭제로 재시도 가드를 초기화하지 못하게 한다.
  SELECT EXISTS (
    SELECT 1 FROM (
      SELECT content_key FROM venue_story_comments
      WHERE user_id = p_user_id
        AND story_id = p_story_id
        AND created_at > v_now - INTERVAL '5 minutes'
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

REVOKE ALL ON FUNCTION venue_story_comment_post(BIGINT, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION venue_story_comment_post(BIGINT, UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION venue_story_comment_post(BIGINT, UUID, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION venue_story_comment_post(BIGINT, UUID, TEXT, TEXT) TO service_role;
