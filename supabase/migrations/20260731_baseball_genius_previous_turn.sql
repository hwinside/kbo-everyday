-- 야잘알봇 S0 멀티턴 맥락 (spec: specs/baseball-genius-v2-hybrid-rag.md §4.1 B1~B3)
-- 현재 질문 "바로 직전"의 user turn 1개만 후보로 돌려준다. 과거 폴백은 없다 —
-- 이 1행이 부적격이면 호출자(selectContextTurn)가 맥락 없음으로 종료하며,
-- 중간에 낀 blocked/in-flight/new-topic turn이 그대로 barrier가 된다.
CREATE OR REPLACE FUNCTION public.baseball_genius_previous_turn(p_message_id bigint)
RETURNS TABLE (
  question text,
  answer text,
  job_source text,
  answered_at timestamptz,
  current_created_at timestamptz
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
    -- B2: 같은 conversation·같은 user의 (created_at, id) 사전순 직전 1행.
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
    c.created_at AS current_created_at
  FROM previous_turn p
  CROSS JOIN current_turn c
  -- B3: 자격 필드는 genius_question_jobs.source (genius_question_logs.match_path는
  -- message_id FK가 없어 turn과 exact join 불가 → 사용하지 않는다).
  LEFT JOIN public.genius_question_jobs j ON j.message_id = p.id
  -- B2: 답변 DM이 실제 존재할 때만 소스 자격 (dedup_key exact, 봇 발신, 같은 conversation).
  LEFT JOIN public.dm_messages a
    ON a.dedup_key = 'baseball-genius:' || p.id
   AND a.sender_id = '45ae7419-6a9a-4c6b-9101-8d65df7e242e'::uuid
   AND a.conversation_id = c.conversation_id;
$$;

REVOKE ALL ON FUNCTION public.baseball_genius_previous_turn(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.baseball_genius_previous_turn(bigint) FROM anon;
REVOKE ALL ON FUNCTION public.baseball_genius_previous_turn(bigint) FROM authenticated;
-- service_role만 실행 자격(neutral Postgres에서도 자립하도록 명시 GRANT — default ACL 의존 금지).
GRANT EXECUTE ON FUNCTION public.baseball_genius_previous_turn(bigint) TO service_role;

-- (q.conversation_id, q.sender_id, q.created_at DESC, q.id DESC) 직전 turn 조회 인덱스.
CREATE INDEX IF NOT EXISTS idx_dm_messages_conversation_sender_recent
  ON public.dm_messages (conversation_id, sender_id, created_at DESC, id DESC);

-- 후속형인데 이어붙일 직전 turn이 없는 경로(context_missing)를 로그 allowlist에 추가한다.
ALTER TABLE public.genius_question_logs
  DROP CONSTRAINT IF EXISTS genius_question_logs_match_path_check;
ALTER TABLE public.genius_question_logs
  ADD CONSTRAINT genius_question_logs_match_path_check CHECK (
    match_path IN (
      'dictionary','cache','llm','service_redirect','history_hold',
      'blocked','unsure','limited','error','context_missing'
    )
  );
