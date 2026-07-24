-- 건의함(피드백) 회신으로 생성된 운영팀 대화를 수신함에 노출한다.
-- 기존 수신함은 "유저 발신 1건+"만 노출 → 피드백 폼으로 인입된 건은
-- 유저 DM이 없어 운영팀 발신만 존재 → 수신함에서 누락되던 문제를 해결.

-- 1) 대화 출처 마킹 컬럼 (기본 'dm', 피드백 회신 대화는 'feedback')
ALTER TABLE public.dm_conversations
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'dm';

-- 수신함 후보 필터를 인덱스로 지원 (feedback 대화 최신순 스캔)
CREATE INDEX IF NOT EXISTS idx_dm_conversations_origin_feedback
  ON public.dm_conversations (last_message_at DESC, id DESC)
  WHERE origin = 'feedback';

-- 2) 수신함 페이지 RPC: 노출 조건을 "유저 발신 1건+ OR origin='feedback'"으로 확장
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
      AND (
        c.origin = 'feedback'
        OR EXISTS (
          SELECT 1
          FROM public.dm_messages eligibility_message
          WHERE eligibility_message.conversation_id = c.id
            AND eligibility_message.sender_id <> p_system_user_id
        )
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
      AND (
        c.origin = 'feedback'
        OR EXISTS (
          SELECT 1
          FROM public.dm_messages eligibility_message
          WHERE eligibility_message.conversation_id = c.id
            AND eligibility_message.sender_id <> p_system_user_id
        )
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

REVOKE ALL ON FUNCTION public.admin_dm_inbox_page(UUID, TIMESTAMPTZ, UUID, INT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_dm_inbox_page(UUID, TIMESTAMPTZ, UUID, INT)
  TO service_role;
