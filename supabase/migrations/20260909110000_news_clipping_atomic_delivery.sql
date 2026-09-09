-- Current-day delivery only. Existing claims (including historical orphans)
-- are not replayed: any retrospective resend needs a separate owner decision.
-- Claim, conversation, message, and inbox preview commit or roll back together.
-- The existing PK starts with clip_date; it cannot efficiently answer each
-- recipient's prior-day history probe. Do not wait behind active writers.
SET lock_timeout = '5s';
CREATE INDEX IF NOT EXISTS idx_news_clipping_sends_user_date
  ON public.news_clipping_sends (user_id, clip_date);

CREATE OR REPLACE FUNCTION public.deliver_news_clipping_batch(
  p_clip_date date,
  p_team_id integer,
  p_sender_id uuid,
  p_system_user_id uuid,
  p_excluded_user_ids uuid[],
  p_content text,
  p_payload jsonb,
  p_first_intro text,
  p_limit integer DEFAULT 400,
  p_recipient_ids uuid[] DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user record;
  v_conversation uuid;
  v_user1 uuid;
  v_user2 uuid;
  v_payload jsonb;
  v_sent integer := 0;
  v_first integer := 0;
  v_targets integer;
  v_eligible integer;
  v_already integer;
  v_now timestamptz;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF p_clip_date IS DISTINCT FROM (now() AT TIME ZONE 'Asia/Seoul')::date
    OR p_team_id IS NULL OR p_team_id NOT BETWEEN 1 AND 10
    OR p_sender_id IS NULL OR p_system_user_id IS NULL
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 400
    OR p_excluded_user_ids IS NULL OR cardinality(p_excluded_user_ids) > 32
    OR (p_recipient_ids IS NOT NULL AND cardinality(p_recipient_ids) > 400)
    OR nullif(btrim(p_content), '') IS NULL
    OR p_payload->>'type' IS DISTINCT FROM 'news_clipping'
    OR p_payload->>'team_id' IS DISTINCT FROM p_team_id::text
    OR p_payload->>'date' IS DISTINCT FROM (p_clip_date - 1)::text
    OR nullif(p_payload->>'team_name', '') IS NULL
  THEN
    RAISE EXCEPTION 'invalid current-day clipping batch';
  END IF;
  IF p_payload ? 'digest_id' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.news_clipping_digests d
      WHERE d.id::text = p_payload->>'digest_id'
        AND d.team_id = p_team_id AND d.clip_date = p_clip_date - 1
        AND jsonb_typeof(d.articles) = 'array' AND jsonb_array_length(d.articles) > 0
    ) THEN RAISE EXCEPTION 'clipping digest scope mismatch'; END IF;
  ELSIF jsonb_typeof(p_payload->'articles') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_payload->'articles') = 0 THEN
    RAISE EXCEPTION 'nonempty clipping articles required';
  END IF;

  -- NOT EXISTS is a resumable work queue, not a permanent cursor. A skipped
  -- or rolled-back recipient is reconsidered on the next scheduled invocation.
  FOR v_user IN
    SELECT p.id, p.nickname
    FROM public.profiles p
    LEFT JOIN public.notification_prefs n ON n.user_id = p.id
    WHERE p.team_id = p_team_id AND p.id <> p_sender_id AND p.id <> p_system_user_id
      AND NOT (p.id = ANY(p_excluded_user_ids))
      AND (p_recipient_ids IS NULL OR p.id = ANY(p_recipient_ids))
      AND coalesce(n.news_clipping, true)
      AND NOT EXISTS (SELECT 1 FROM public.news_clipping_sends s WHERE s.clip_date = p_clip_date AND s.user_id = p.id)
    ORDER BY p.id
    LIMIT p_limit
  LOOP
    INSERT INTO public.news_clipping_sends (clip_date, user_id, team_id)
    VALUES (p_clip_date, v_user.id, p_team_id)
    ON CONFLICT (clip_date, user_id) DO NOTHING;
    IF NOT FOUND THEN CONTINUE; END IF;

    v_user1 := least(p_sender_id, v_user.id);
    v_user2 := greatest(p_sender_id, v_user.id);
    INSERT INTO public.dm_conversations (user1_id, user2_id)
    VALUES (v_user1, v_user2)
    ON CONFLICT (user1_id, user2_id) DO UPDATE SET user1_id = excluded.user1_id
    RETURNING id INTO v_conversation;

    v_payload := p_payload - 'intro';
    IF NOT EXISTS (SELECT 1 FROM public.news_clipping_sends s WHERE s.user_id = v_user.id AND s.clip_date < p_clip_date) THEN
      v_payload := v_payload || jsonb_build_object('intro', replace(coalesce(p_first_intro, ''), '{{nickname}}', coalesce(v_user.nickname, '팬')));
      v_first := v_first + 1;
    END IF;
    v_now := clock_timestamp();
    INSERT INTO public.dm_messages (conversation_id, sender_id, content, payload, created_at)
    VALUES (v_conversation, p_sender_id, p_content, v_payload, v_now);
    UPDATE public.dm_conversations
    SET last_message = p_content, last_message_at = v_now
    WHERE id = v_conversation AND (last_message_at IS NULL OR last_message_at <= v_now);
    v_sent := v_sent + 1;
  END LOOP;

  SELECT count(*)::integer,
    count(*) FILTER (WHERE coalesce(n.news_clipping, true))::integer,
    count(*) FILTER (WHERE coalesce(n.news_clipping, true) AND EXISTS (
      SELECT 1 FROM public.news_clipping_sends s WHERE s.clip_date = p_clip_date AND s.user_id = p.id
    ))::integer
  INTO v_targets, v_eligible, v_already
  FROM public.profiles p LEFT JOIN public.notification_prefs n ON n.user_id = p.id
  WHERE p.team_id = p_team_id AND p.id <> p_sender_id AND p.id <> p_system_user_id
    AND NOT (p.id = ANY(p_excluded_user_ids))
    AND (p_recipient_ids IS NULL OR p.id = ANY(p_recipient_ids));
  RETURN jsonb_build_object('sent', v_sent, 'firstIntro', v_first,
    'targets', v_targets, 'skippedPref', v_targets - v_eligible,
    'alreadySent', v_already - v_sent, 'remaining', v_eligible - v_already);
END;
$$;

REVOKE ALL ON FUNCTION public.deliver_news_clipping_batch(date, integer, uuid, uuid, uuid[], text, jsonb, text, integer, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deliver_news_clipping_batch(date, integer, uuid, uuid, uuid[], text, jsonb, text, integer, uuid[]) TO service_role;
COMMENT ON FUNCTION public.deliver_news_clipping_batch(date, integer, uuid, uuid, uuid[], text, jsonb, text, integer, uuid[])
IS 'Atomic current-day clipping batches; no historical resend. Optional recipients restrict dedicated-account QA; cron omits them.';
NOTIFY pgrst, 'reload schema';
RESET lock_timeout;
