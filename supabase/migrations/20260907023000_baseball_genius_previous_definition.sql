-- Additive v2: keep the deployed v1 signature intact for rollback/old workers.
-- Select the exact same immediate user turn and join its final-envelope text.
-- No history scan, no question-text join, no extra table/column or client access.
BEGIN;
CREATE OR REPLACE FUNCTION public.baseball_genius_previous_turn_v2(p_message_id bigint)
RETURNS TABLE (
  question text,
  answer text,
  job_source text,
  answered_at timestamptz,
  current_created_at timestamptz,
  definition_llm_text text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH current_turn AS (
    SELECT m.id, m.conversation_id, m.sender_id, m.created_at
    FROM public.dm_messages m
    WHERE m.id = p_message_id
  ), previous_turn AS (
    SELECT q.id, q.content, q.created_at
    FROM public.dm_messages q, current_turn c
    WHERE q.conversation_id = c.conversation_id
      AND q.sender_id = c.sender_id
      AND (q.created_at, q.id) < (c.created_at, c.id)
    ORDER BY q.created_at DESC, q.id DESC
    LIMIT 1
  )
  SELECT
    p.content AS question,
    a.content AS answer,
    j.source AS job_source,
    a.created_at AS answered_at,
    c.created_at AS current_created_at,
    j.llm_text AS definition_llm_text
  FROM previous_turn p
  CROSS JOIN current_turn c
  LEFT JOIN public.genius_question_jobs j ON j.message_id = p.id
  LEFT JOIN public.dm_messages a
    ON a.dedup_key = 'baseball-genius:' || p.id
   AND a.sender_id = '45ae7419-6a9a-4c6b-9101-8d65df7e242e'::uuid
   AND a.conversation_id = c.conversation_id;
$$;

REVOKE ALL ON FUNCTION public.baseball_genius_previous_turn_v2(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baseball_genius_previous_turn_v2(bigint) FROM anon;
REVOKE ALL ON FUNCTION public.baseball_genius_previous_turn_v2(bigint) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.baseball_genius_previous_turn_v2(bigint) TO service_role;
COMMIT;
