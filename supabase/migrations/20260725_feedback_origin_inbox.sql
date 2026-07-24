-- 건의함(피드백) 회신 대화를 운영팀 쪽지함 수신함에 노출한다.
--
-- 문제: admin_dm_inbox_page 는 "유저 발신 메시지 1건+" 대화만 노출한다.
-- 건의함(피드백 폼)으로 인입된 건은 유저가 DM 을 보낸 게 아니라 피드백을 남긴 것이라,
-- cs-feedback 에서 쪽지로 회신하면 대화에 운영팀 발신만 존재 → 수신함에서 빠진다.
--
-- 해결(최소 변경, additive): dm_conversations 에 origin 컬럼을 추가하고(기본 'dm'),
-- 피드백 회신 시 대화를 origin='feedback' 으로 마킹한다.
-- 수신함 노출 조건을 "유저 발신 1건+ OR origin='feedback'" 으로 확장한다.
-- 일반 유저 쪽지함(useDM.ts)과 broadcast 선발신 대화는 영향받지 않는다.

ALTER TABLE public.dm_conversations
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'dm';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dm_conversations_origin_check'
  ) THEN
    ALTER TABLE public.dm_conversations
      ADD CONSTRAINT dm_conversations_origin_check CHECK (origin IN ('dm', 'feedback'));
  END IF;
END $$;

-- RETURNS TABLE 에 origin 컬럼을 추가하므로 기존 함수를 먼저 DROP 한다
-- (CREATE OR REPLACE 로는 반환 타입을 변경할 수 없다).
DROP FUNCTION IF EXISTS public.admin_dm_inbox_page(UUID, TIMESTAMPTZ, UUID, INT);

CREATE FUNCTION public.admin_dm_inbox_page(
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
    counts.sys_msg_count,
    c.origin
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
