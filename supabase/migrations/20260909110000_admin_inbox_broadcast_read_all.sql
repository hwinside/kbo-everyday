-- Admin-only projection. No messages or shared conversation previews are changed.
-- Existing queued broadcasts already carry the server-only admin-broadcast: dedup key.
BEGIN;

CREATE INDEX IF NOT EXISTS idx_dm_messages_admin_individual_latest
  ON public.dm_messages (conversation_id, created_at DESC, id DESC)
  WHERE COALESCE(dedup_key, '') NOT LIKE 'admin-broadcast:%';

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
  sys_msg_count BIGINT,
  origin TEXT
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH eligible AS MATERIALIZED (
    SELECT conversation.*, latest.content AS inbox_content,
      latest.image_urls AS inbox_images, latest.created_at AS sort_at
    FROM public.dm_conversations conversation
    -- Shared conversation previews include broadcasts for the recipient's inbox.
    -- Derive only this admin list from the last non-broadcast message instead.
    CROSS JOIN LATERAL (
      SELECT message.content, message.image_urls, message.created_at
      FROM public.dm_messages message
      WHERE message.conversation_id = conversation.id
        AND COALESCE(message.dedup_key, '') NOT LIKE 'admin-broadcast:%'
      ORDER BY message.created_at DESC, message.id DESC
      LIMIT 1
    ) latest
    WHERE (conversation.user1_id = p_system_user_id
        OR conversation.user2_id = p_system_user_id)
      AND (
        conversation.origin = 'feedback'
        OR EXISTS (
          SELECT 1 FROM public.dm_messages eligibility_message
          WHERE eligibility_message.conversation_id = conversation.id
            AND eligibility_message.sender_id IS DISTINCT FROM p_system_user_id
        )
      )
  ), page AS MATERIALIZED (
    SELECT conversation.*
    FROM eligible conversation
    WHERE p_cursor_at IS NULL
       OR conversation.sort_at < p_cursor_at
       OR (
         conversation.sort_at = p_cursor_at
         AND conversation.id < p_cursor_id
       )
    ORDER BY conversation.sort_at DESC, conversation.id DESC
    LIMIT LEAST(GREATEST(p_limit, 1), 101)
  )
  SELECT
    conversation.id,
    CASE
      WHEN conversation.user1_id = p_system_user_id
        THEN conversation.user2_id
      ELSE conversation.user1_id
    END AS other_user_id,
    CASE
      WHEN (
        CASE
          WHEN conversation.user1_id = p_system_user_id
            THEN conversation.user2_id
          ELSE conversation.user1_id
        END
      ) IS NULL
        THEN '탈퇴한 사용자'
      ELSE COALESCE(profile.nickname::TEXT, '알 수 없음')
    END AS other_nickname,
    profile.team_id,
    LEFT(COALESCE(NULLIF(BTRIM(conversation.inbox_content), ''),
      CASE WHEN COALESCE(CARDINALITY(conversation.inbox_images), 0) > 0
        THEN '[사진]' ELSE '[메시지]' END), 100) AS last_message,
    conversation.sort_at AS last_message_at,
    counts.unread_count,
    counts.user_msg_count,
    counts.sys_msg_count,
    conversation.origin
  FROM page conversation
  LEFT JOIN public.profiles profile
    ON profile.id = CASE
      WHEN conversation.user1_id = p_system_user_id
        THEN conversation.user2_id
      ELSE conversation.user1_id
    END
  CROSS JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (
        WHERE message.sender_id IS DISTINCT FROM p_system_user_id
          AND message.is_read = FALSE
      )::BIGINT AS unread_count,
      COUNT(*) FILTER (
        WHERE message.sender_id IS DISTINCT FROM p_system_user_id
      )::BIGINT AS user_msg_count,
      COUNT(*) FILTER (
        WHERE message.sender_id = p_system_user_id
          AND COALESCE(message.dedup_key, '') NOT LIKE 'admin-broadcast:%'
      )::BIGINT AS sys_msg_count
    FROM public.dm_messages message
    WHERE message.conversation_id = conversation.id
  ) counts
  ORDER BY conversation.sort_at DESC, conversation.id DESC;
$$;

REVOKE ALL ON FUNCTION public.admin_dm_inbox_page(UUID, TIMESTAMPTZ, UUID, INT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_dm_inbox_page(UUID, TIMESTAMPTZ, UUID, INT)
  TO service_role;

-- One statement/snapshot, independent of loaded pages. Newly arriving messages
-- after this statement remain unread. Never change recipients' read receipts.
CREATE OR REPLACE FUNCTION public.admin_dm_mark_all_read(p_system_user_id UUID)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  updated_count BIGINT;
BEGIN
  IF p_system_user_id IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'missing system user';
  END IF;

  UPDATE public.dm_messages message
  SET is_read = TRUE
  WHERE message.is_read = FALSE
    AND message.sender_id IS DISTINCT FROM p_system_user_id
    AND EXISTS (
      SELECT 1 FROM public.dm_conversations conversation
      WHERE conversation.id = message.conversation_id
        AND (conversation.user1_id = p_system_user_id
          OR conversation.user2_id = p_system_user_id)
    );
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_dm_mark_all_read(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_dm_mark_all_read(UUID) TO service_role;

COMMIT;
