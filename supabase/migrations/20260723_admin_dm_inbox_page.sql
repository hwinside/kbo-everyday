-- 운영자 쪽지함: 수신 자격 판정과 최신순 페이지네이션을 DB 안에서 끝낸다.
-- 전체 대화를 애플리케이션으로 가져와 메시지를 3회 재집계하던 경로를 대체한다.

CREATE INDEX IF NOT EXISTS idx_dm_conversations_user1_last_message
  ON public.dm_conversations (user1_id, last_message_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_dm_conversations_user2_last_message
  ON public.dm_conversations (user2_id, last_message_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_dm_messages_unread_sender
  ON public.dm_messages (conversation_id, sender_id)
  WHERE is_read = FALSE;

CREATE OR REPLACE FUNCTION public.admin_dm_inbox_page(
  p_system_user_id UUID,
  p_cursor_at TIMESTAMPTZ DEFAULT NULL,
  p_cursor_id UUID DEFAULT NULL,
  p_limit INT DEFAULT 51
)
RETURNS TABLE (
  id UUID,
  other_user_id UUID,
  other_nickname TEXT,
  other_team_id INT,
  last_message TEXT,
  last_message_at TIMESTAMPTZ,
  unread_count BIGINT,
  user_msg_count BIGINT,
  sys_msg_count BIGINT
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH eligible AS MATERIALIZED (
    SELECT
      c.*,
      COALESCE(
        c.last_message_at,
        (SELECT MAX(fallback_message.created_at)
         FROM public.dm_messages fallback_message
         WHERE fallback_message.conversation_id = c.id),
        c.created_at
      ) AS sort_at
    FROM public.dm_conversations c
    WHERE c.user1_id = p_system_user_id
      AND EXISTS (
        SELECT 1
        FROM public.dm_messages eligibility_message
        WHERE eligibility_message.conversation_id = c.id
          AND eligibility_message.sender_id <> p_system_user_id
      )

    UNION ALL

    SELECT
      c.*,
      COALESCE(
        c.last_message_at,
        (SELECT MAX(fallback_message.created_at)
         FROM public.dm_messages fallback_message
         WHERE fallback_message.conversation_id = c.id),
        c.created_at
      ) AS sort_at
    FROM public.dm_conversations c
    WHERE c.user2_id = p_system_user_id
      AND EXISTS (
        SELECT 1
        FROM public.dm_messages eligibility_message
        WHERE eligibility_message.conversation_id = c.id
          AND eligibility_message.sender_id <> p_system_user_id
      )
  ), page AS MATERIALIZED (
    SELECT c.*
    FROM eligible c
    WHERE p_cursor_at IS NULL
       OR c.sort_at < p_cursor_at
       OR (c.sort_at = p_cursor_at AND c.id < p_cursor_id)
    ORDER BY c.sort_at DESC, c.id DESC
    LIMIT LEAST(GREATEST(p_limit, 1), 101)
  )
  SELECT
    c.id,
    CASE WHEN c.user1_id = p_system_user_id THEN c.user2_id ELSE c.user1_id END AS other_user_id,
    COALESCE(profile.nickname::TEXT, '알 수 없음') AS other_nickname,
    profile.team_id,
    c.last_message,
    c.sort_at AS last_message_at,
    counts.unread_count,
    counts.user_msg_count,
    counts.sys_msg_count
  FROM page c
  LEFT JOIN public.profiles profile
    ON profile.id = CASE WHEN c.user1_id = p_system_user_id THEN c.user2_id ELSE c.user1_id END
  CROSS JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (
        WHERE message.sender_id <> p_system_user_id AND message.is_read = FALSE
      )::BIGINT AS unread_count,
      COUNT(*) FILTER (WHERE message.sender_id <> p_system_user_id)::BIGINT AS user_msg_count,
      COUNT(*) FILTER (WHERE message.sender_id = p_system_user_id)::BIGINT AS sys_msg_count
    FROM public.dm_messages message
    WHERE message.conversation_id = c.id
  ) counts
  ORDER BY c.sort_at DESC, c.id DESC;
$$;

CREATE OR REPLACE FUNCTION public.admin_dm_unread_total(p_system_user_id UUID)
RETURNS BIGINT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COUNT(*)::BIGINT
  FROM public.dm_messages message
  WHERE message.sender_id <> p_system_user_id
    AND message.is_read = FALSE
    AND EXISTS (
      SELECT 1
      FROM public.dm_conversations conversation
      WHERE conversation.id = message.conversation_id
        AND (
          conversation.user1_id = p_system_user_id
          OR conversation.user2_id = p_system_user_id
        )
    );
$$;

REVOKE ALL ON FUNCTION public.admin_dm_inbox_page(UUID, TIMESTAMPTZ, UUID, INT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_dm_inbox_page(UUID, TIMESTAMPTZ, UUID, INT)
  TO service_role;

REVOKE ALL ON FUNCTION public.admin_dm_unread_total(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_dm_unread_total(UUID)
  TO service_role;
