-- Tier B 질문 교정: 자동 재라우팅 대신 서버 발급 후보를 유저가 고른 경우에만 원 job 재처리.

ALTER TABLE public.genius_question_logs
  DROP CONSTRAINT IF EXISTS genius_question_logs_match_path_check;
ALTER TABLE public.genius_question_logs
  ADD CONSTRAINT genius_question_logs_match_path_check CHECK (
    match_path IN (
      'dictionary','cache','llm','service_redirect','history_hold',
      'blocked','unsure','limited','error','context_missing','ack','rag',
      'player_picker','question_correction','kbo_structured',
      'team_rag','news_rag','scope_guide','name_suggest'
    )
  );

ALTER TABLE public.genius_question_logs
  DROP CONSTRAINT IF EXISTS genius_question_logs_normalize_status_check;
ALTER TABLE public.genius_question_logs
  ADD CONSTRAINT genius_question_logs_normalize_status_check CHECK (
    question_normalize_status IS NULL OR question_normalize_status IN (
      'accepted_surface','suggested','accepted_user','rejected','no_change','error'
    )
  );

ALTER TABLE public.genius_question_jobs
  ADD COLUMN IF NOT EXISTS picked_normalized_question text,
  ADD COLUMN IF NOT EXISTS correction_options jsonb;

CREATE OR REPLACE FUNCTION public.prepare_baseball_genius_question_correction(
  p_message_id bigint,
  p_user_id uuid,
  p_picked_normalized_question text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_changed integer;
BEGIN
  IF p_message_id IS NULL OR p_message_id < 1 OR p_user_id IS NULL
     OR nullif(btrim(p_picked_normalized_question), '') IS NULL
     OR length(p_picked_normalized_question) > 200 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'invalid question correction';
  END IF;

  UPDATE public.genius_question_jobs
  SET picked_normalized_question = p_picked_normalized_question,
      status = 'queued',
      lease_until = clock_timestamp(),
      answer = NULL,
      source = NULL,
      remaining = NULL,
      correction_options = NULL,
      quota_reserved = CASE WHEN quota_released THEN false ELSE quota_reserved END,
      quota_allowed = CASE WHEN quota_released THEN NULL ELSE quota_allowed END,
      quota_remaining = CASE WHEN quota_released THEN NULL ELSE quota_remaining END,
      quota_kst_day = CASE WHEN quota_released THEN NULL ELSE quota_kst_day END,
      quota_released = false,
      attempts = 0,
      delivery_attempts = 0,
      last_error = NULL,
      updated_at = now()
  WHERE message_id = p_message_id
    AND user_id = p_user_id
    AND status = 'awaiting_selection'
    AND correction_options = jsonb_build_array(p_picked_normalized_question);
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed = 1 THEN RETURN true; END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.genius_question_jobs
    WHERE message_id = p_message_id AND user_id = p_user_id
      AND picked_normalized_question = p_picked_normalized_question
      AND status IN ('queued', 'processing', 'ready', 'completed')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_baseball_genius_question_correction(bigint, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_baseball_genius_question_correction(bigint, uuid, text)
  TO service_role;
