-- Account deletion must be atomic from auth.users.
--
-- Existing NO ACTION foreign keys caused GoTrue deleteUser to fail after the
-- API route had already deleted profiles. That left signed-in zombie accounts
-- and retried the same 500 error hundreds of times.

ALTER TABLE public.admin_page_views
  DROP CONSTRAINT admin_page_views_user_id_fkey,
  ADD CONSTRAINT admin_page_views_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE SET NULL;

-- DMs and abuse reports are SHARED evidence: a single user's deletion must not
-- erase the other participant's conversation history, nor destroy abuse-report
-- evidence. Preserve the rows and anonymize the departed user's identity
-- (SET NULL) instead of cascading. Columns are currently NOT NULL, so relax
-- them first (DROP NOT NULL is a no-op if already nullable).
ALTER TABLE public.dm_conversations
  ALTER COLUMN user1_id DROP NOT NULL,
  ALTER COLUMN user2_id DROP NOT NULL;

ALTER TABLE public.dm_conversations
  DROP CONSTRAINT dm_conversations_user1_id_fkey,
  DROP CONSTRAINT dm_conversations_user2_id_fkey,
  ADD CONSTRAINT dm_conversations_user1_id_fkey
    FOREIGN KEY (user1_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD CONSTRAINT dm_conversations_user2_id_fkey
    FOREIGN KEY (user2_id) REFERENCES auth.users (id) ON DELETE SET NULL;

ALTER TABLE public.dm_messages
  ALTER COLUMN sender_id DROP NOT NULL;

ALTER TABLE public.dm_messages
  DROP CONSTRAINT dm_messages_sender_id_fkey,
  ADD CONSTRAINT dm_messages_sender_id_fkey
    FOREIGN KEY (sender_id) REFERENCES auth.users (id) ON DELETE SET NULL;

ALTER TABLE public.dm_reports
  ALTER COLUMN reporter_id DROP NOT NULL,
  ALTER COLUMN reported_user_id DROP NOT NULL;

-- conversation_id keeps CASCADE, but conversations are now preserved (SET NULL
-- above), so a participant's deletion no longer removes the conversation or its
-- reports. reporter_id/reported_user_id anonymize so the report record and its
-- linked conversation evidence survive.
ALTER TABLE public.dm_reports
  DROP CONSTRAINT dm_reports_reporter_id_fkey,
  DROP CONSTRAINT dm_reports_reported_user_id_fkey,
  ADD CONSTRAINT dm_reports_reporter_id_fkey
    FOREIGN KEY (reporter_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD CONSTRAINT dm_reports_reported_user_id_fkey
    FOREIGN KEY (reported_user_id) REFERENCES auth.users (id) ON DELETE SET NULL;

-- A preserved conversation remains readable by its surviving participant, but
-- it becomes permanently read-only once either participant is gone. Tighten
-- the INSERT policies at the same time: the previous dm_messages policy did
-- not prove that the sender belonged to the referenced conversation.
DROP POLICY IF EXISTS dm_conv_insert ON public.dm_conversations;
CREATE POLICY dm_conv_insert ON public.dm_conversations FOR INSERT
  WITH CHECK (
    user1_id IS NOT NULL
    AND user2_id IS NOT NULL
    AND (auth.uid() = user1_id OR auth.uid() = user2_id)
    AND NOT EXISTS (
      SELECT 1
      FROM public.user_blocks
      WHERE (blocker_id = user1_id AND blocked_id = user2_id)
         OR (blocker_id = user2_id AND blocked_id = user1_id)
    )
  );

DROP POLICY IF EXISTS dm_msg_insert ON public.dm_messages;
CREATE POLICY dm_msg_insert ON public.dm_messages FOR INSERT
  WITH CHECK (
    auth.uid() = sender_id
    AND EXISTS (
      SELECT 1
      FROM public.dm_conversations conversation
      WHERE conversation.id = conversation_id
        AND conversation.user1_id IS NOT NULL
        AND conversation.user2_id IS NOT NULL
        AND (
          conversation.user1_id = auth.uid()
          OR conversation.user2_id = auth.uid()
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.user_blocks
          WHERE (
            blocker_id = conversation.user1_id
            AND blocked_id = conversation.user2_id
          ) OR (
            blocker_id = conversation.user2_id
            AND blocked_id = conversation.user1_id
          )
        )
    )
  );

-- Return at most one unread-count row per requested conversation. The caller
-- cannot count another user's inbox: participant membership is checked against
-- auth.uid(), and SECURITY INVOKER keeps the underlying RLS in force.
CREATE OR REPLACE FUNCTION public.dm_unread_counts(
  p_conversation_ids UUID[]
)
RETURNS TABLE (
  conversation_id UUID,
  unread_count BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF COALESCE(cardinality(p_conversation_ids), 0) > 500 THEN
    RAISE EXCEPTION 'too_many_conversation_ids'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    message.conversation_id,
    COUNT(*)::BIGINT AS unread_count
  FROM public.dm_messages message
  JOIN public.dm_conversations conversation
    ON conversation.id = message.conversation_id
  WHERE message.conversation_id = ANY(COALESCE(p_conversation_ids, '{}'))
    AND (
      conversation.user1_id = auth.uid()
      OR conversation.user2_id = auth.uid()
    )
    AND message.is_read = FALSE
    AND message.sender_id IS DISTINCT FROM auth.uid()
  GROUP BY message.conversation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.dm_unread_counts(UUID[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dm_unread_counts(UUID[])
  TO authenticated;

-- SQL <> excludes NULL. An unread message whose departed sender was anonymized
-- is still "not sent by me", so inbox eligibility/counts use IS DISTINCT FROM.
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
    SELECT
      conversation.*,
      COALESCE(
        conversation.last_message_at,
        (SELECT MAX(fallback_message.created_at)
         FROM public.dm_messages fallback_message
         WHERE fallback_message.conversation_id = conversation.id),
        conversation.created_at
      ) AS sort_at
    FROM public.dm_conversations conversation
    WHERE conversation.user1_id = p_system_user_id
      AND (
        conversation.origin = 'feedback'
        OR EXISTS (
          SELECT 1
          FROM public.dm_messages eligibility_message
          WHERE eligibility_message.conversation_id = conversation.id
            AND eligibility_message.sender_id IS DISTINCT FROM p_system_user_id
        )
      )

    UNION ALL

    SELECT
      conversation.*,
      COALESCE(
        conversation.last_message_at,
        (SELECT MAX(fallback_message.created_at)
         FROM public.dm_messages fallback_message
         WHERE fallback_message.conversation_id = conversation.id),
        conversation.created_at
      ) AS sort_at
    FROM public.dm_conversations conversation
    WHERE conversation.user2_id = p_system_user_id
      AND (
        conversation.origin = 'feedback'
        OR EXISTS (
          SELECT 1
          FROM public.dm_messages eligibility_message
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
    conversation.last_message,
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
      )::BIGINT AS sys_msg_count
    FROM public.dm_messages message
    WHERE message.conversation_id = conversation.id
  ) counts
  ORDER BY conversation.sort_at DESC, conversation.id DESC;
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
  WHERE message.sender_id IS DISTINCT FROM p_system_user_id
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

ALTER TABLE public.feedback
  DROP CONSTRAINT feedback_user_id_fkey,
  ADD CONSTRAINT feedback_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE;

ALTER TABLE public.feedback_votes
  DROP CONSTRAINT feedback_votes_user_id_fkey,
  ADD CONSTRAINT feedback_votes_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE;

ALTER TABLE public.invitations
  DROP CONSTRAINT invitations_invitee_id_fkey,
  DROP CONSTRAINT invitations_inviter_id_fkey,
  ADD CONSTRAINT invitations_invitee_id_fkey
    FOREIGN KEY (invitee_id) REFERENCES public.profiles (id) ON DELETE SET NULL,
  ADD CONSTRAINT invitations_inviter_id_fkey
    FOREIGN KEY (inviter_id) REFERENCES public.profiles (id) ON DELETE SET NULL;

ALTER TABLE public.profiles
  DROP CONSTRAINT profiles_invited_by_fkey,
  ADD CONSTRAINT profiles_invited_by_fkey
    FOREIGN KEY (invited_by) REFERENCES public.profiles (id) ON DELETE SET NULL;

ALTER TABLE public.reports
  ALTER COLUMN reporter_id DROP NOT NULL;

ALTER TABLE public.reports
  DROP CONSTRAINT reports_reporter_id_fkey,
  ADD CONSTRAINT reports_reporter_id_fkey
    FOREIGN KEY (reporter_id) REFERENCES public.profiles (id) ON DELETE SET NULL;

ALTER TABLE public.user_blocks
  DROP CONSTRAINT user_blocks_blocker_id_fkey,
  DROP CONSTRAINT user_blocks_blocked_id_fkey,
  ADD CONSTRAINT user_blocks_blocker_id_fkey
    FOREIGN KEY (blocker_id) REFERENCES auth.users (id) ON DELETE CASCADE,
  ADD CONSTRAINT user_blocks_blocked_id_fkey
    FOREIGN KEY (blocked_id) REFERENCES auth.users (id) ON DELETE CASCADE;
