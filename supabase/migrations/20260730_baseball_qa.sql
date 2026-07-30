-- 야잘알봇 고정 DM Q&A MVP (Notion SSOT v1.2)
-- ⚠️ 운영 DB 직접 적용 금지 — 머지 게이트 후 시스템 계정 프로비저닝과 함께 적용.

CREATE TABLE IF NOT EXISTS public.baseball_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term text NOT NULL UNIQUE,
  aliases text[] NOT NULL DEFAULT '{}',
  answer text NOT NULL,
  category text NOT NULL DEFAULT 'rule',
  source_kind text NOT NULL CHECK (source_kind IN ('official_rule', 'official_record', 'editorial_definition')),
  source_url text,
  rule_version text NOT NULL,
  reviewed_at date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.genius_qa_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_norm text NOT NULL UNIQUE,
  answer text NOT NULL,
  hit_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_hit_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.genius_question_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  question text NOT NULL,
  question_norm text NOT NULL,
  match_path text NOT NULL CHECK (
    match_path IN (
      'dictionary','cache','llm','service_redirect','history_hold',
      'blocked','unsure','limited','error'
    )
  ),
  answer text,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_genius_question_logs_user_day
  ON public.genius_question_logs (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.genius_daily_usage (
  user_id uuid NOT NULL,
  kst_day date NOT NULL,
  used integer NOT NULL CHECK (used >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kst_day)
);

CREATE TABLE IF NOT EXISTS public.genius_question_jobs (
  message_id bigint PRIMARY KEY REFERENCES public.dm_messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.dm_conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'processing', 'ready', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts >= 0),
  -- 답변 DM 발송 실패는 처리(attempts)와 분리된 delivery_attempts로 bounded 재시도한다 (삼순 4차 P1).
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  lease_until timestamptz NOT NULL,
  -- crash-after-reserve 재처리가 quota를 중복 소비하지 않도록 messageId 단위로 예약 결과를 고정한다.
  quota_reserved boolean NOT NULL DEFAULT false,
  quota_allowed boolean,
  quota_remaining integer,
  -- LLM 호출 '시작'을 호출 전 atomic CAS(단일 UPDATE ... WHERE llm_started=false)로 획득해
  -- 정확히 한 worker만 winner가 된다 (삼순 5차 P1). started=true인데 llm_text가 없으면 공급자
  -- 소비 여부가 ambiguous하므로 재처리는 LLM을 재호출하지 않고 fail-closed한다 (삼순 4차 P1).
  llm_started boolean NOT NULL DEFAULT false,
  -- CAS winner가 기록하는 시작 시각 — started·결과 없음일 때 winner 생존 fence 판정용.
  -- fence 창 안에서는 loser가 답변 없이 물러나고, 경과 후에만 ambiguous 복구가 동작한다 (삼순 5차 P1).
  llm_started_at timestamptz,
  -- crash-after-LLM 재처리가 LLM을 재호출하지 않도록 응답 원본을 durable 저장한다.
  llm_text text,
  llm_input_tokens integer,
  llm_output_tokens integer,
  answer text,
  source text,
  remaining integer,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_genius_question_jobs_drain
  ON public.genius_question_jobs (status, lease_until)
  WHERE status IN ('queued', 'processing', 'ready', 'failed');

-- 질문 INSERT와 같은 DB 트랜잭션에서 처리 job을 생성한다 (삼순 3차 P0).
-- send_dm_message_atomic 커밋 직후 앱 종료/응답 단절이어도 job은 이미 존재하므로
-- 클라이언트 outbox 없이도 서버 drainer(/api/cron/baseball-qa-drain)가 끝까지 처리한다.
CREATE OR REPLACE FUNCTION public.enqueue_baseball_genius_question()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- 시스템 계정 고정 UUID (src/lib/constants/baseball-genius.ts와 동일 값).
  v_genius constant uuid := '45ae7419-6a9a-4c6b-9101-8d65df7e242e';
  v_is_genius_room boolean;
BEGIN
  IF NEW.sender_id IS NULL OR NEW.sender_id = v_genius THEN
    RETURN NEW;
  END IF;

  SELECT true INTO v_is_genius_room
  FROM public.dm_conversations c
  WHERE c.id = NEW.conversation_id
    AND v_genius IN (c.user1_id, c.user2_id)
    AND NEW.sender_id IN (c.user1_id, c.user2_id);
  IF v_is_genius_room IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.genius_question_jobs (
    message_id, conversation_id, user_id, status, attempts, lease_until
  )
  VALUES (NEW.id, NEW.conversation_id, NEW.sender_id, 'queued', 0, clock_timestamp())
  ON CONFLICT (message_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enqueue_baseball_genius_question ON public.dm_messages;
CREATE TRIGGER trg_enqueue_baseball_genius_question
  AFTER INSERT ON public.dm_messages
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_baseball_genius_question();

-- KST 날짜별 질문 슬롯을 단일 UPSERT로 예약한다. used=limit이면 UPDATE가 0행이라
-- 초과 요청은 모두 allowed=false. DB 오류는 호출 route가 fail-closed 처리한다.
CREATE OR REPLACE FUNCTION public.reserve_baseball_genius_daily_question(
  p_user_id uuid,
  p_limit integer
)
RETURNS TABLE(allowed boolean, remaining integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_used integer;
BEGIN
  IF p_user_id IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'invalid daily reservation';
  END IF;

  INSERT INTO public.genius_daily_usage (user_id, kst_day, used)
  VALUES (p_user_id, (clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date, 1)
  ON CONFLICT (user_id, kst_day)
  DO UPDATE SET used = genius_daily_usage.used + 1, updated_at = now()
  WHERE genius_daily_usage.used < p_limit
  RETURNING used INTO v_used;

  IF v_used IS NULL THEN
    RETURN QUERY SELECT false, 0;
  ELSE
    RETURN QUERY SELECT true, greatest(0, p_limit - v_used);
  END IF;
END;
$$;

-- messageId 단위 durable idempotent quota 예약 (삼순 3차 P1).
-- 같은 트랜잭션에서 job 행을 잠금 → 이미 예약된 메시지면 저장된 결과를 그대로 반환하고
-- usage를 증가시키지 않는다. crash-after-reserve 재처리의 quota 중복 소비를 막는다.
CREATE OR REPLACE FUNCTION public.reserve_baseball_genius_daily_question_for_message(
  p_message_id bigint,
  p_user_id uuid,
  p_limit integer
)
RETURNS TABLE(allowed boolean, remaining integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job public.genius_question_jobs%ROWTYPE;
  v_used integer;
  v_remaining integer;
BEGIN
  IF p_message_id IS NULL OR p_message_id < 1 OR p_user_id IS NULL
     OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'invalid message daily reservation';
  END IF;

  SELECT * INTO v_job
  FROM public.genius_question_jobs
  WHERE message_id = p_message_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'genius question job missing';
  END IF;

  IF v_job.quota_reserved THEN
    RETURN QUERY SELECT coalesce(v_job.quota_allowed, false), coalesce(v_job.quota_remaining, 0);
    RETURN;
  END IF;

  INSERT INTO public.genius_daily_usage (user_id, kst_day, used)
  VALUES (p_user_id, (clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date, 1)
  ON CONFLICT (user_id, kst_day)
  DO UPDATE SET used = genius_daily_usage.used + 1, updated_at = now()
  WHERE genius_daily_usage.used < p_limit
  RETURNING used INTO v_used;

  IF v_used IS NULL THEN
    UPDATE public.genius_question_jobs
    SET quota_reserved = true, quota_allowed = false, quota_remaining = 0, updated_at = now()
    WHERE message_id = p_message_id;
    RETURN QUERY SELECT false, 0;
  ELSE
    v_remaining := greatest(0, p_limit - v_used);
    UPDATE public.genius_question_jobs
    SET quota_reserved = true, quota_allowed = true, quota_remaining = v_remaining, updated_at = now()
    WHERE message_id = p_message_id;
    RETURN QUERY SELECT true, v_remaining;
  END IF;
END;
$$;

-- message_id별 quota/LLM 선행 claim. 같은 메시지의 병렬 요청은 한 건만 claimed가 된다.
-- ready는 파이프라인 결과가 이미 저장되어 답변 INSERT만 재시도하면 되는 상태다.
CREATE OR REPLACE FUNCTION public.claim_baseball_genius_question(
  p_message_id bigint,
  p_conversation_id uuid,
  p_user_id uuid,
  p_lease_seconds integer DEFAULT 30
)
RETURNS TABLE(claim_state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
BEGIN
  IF p_message_id IS NULL OR p_message_id < 1 OR p_conversation_id IS NULL
     OR p_user_id IS NULL OR p_lease_seconds < 5 OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'invalid genius question claim';
  END IF;

  INSERT INTO public.genius_question_jobs (
    message_id, conversation_id, user_id, status, lease_until
  )
  VALUES (
    p_message_id, p_conversation_id, p_user_id, 'processing',
    clock_timestamp() + make_interval(secs => p_lease_seconds)
  )
  ON CONFLICT (message_id) DO NOTHING
  RETURNING status INTO v_status;

  IF v_status IS NOT NULL THEN
    RETURN QUERY SELECT 'claimed'::text;
    RETURN;
  END IF;

  SELECT status INTO v_status
  FROM public.genius_question_jobs
  WHERE message_id = p_message_id
    AND conversation_id = p_conversation_id
    AND user_id = p_user_id;

  IF v_status IN ('ready', 'completed') THEN
    RETURN QUERY SELECT v_status;
    RETURN;
  END IF;

  UPDATE public.genius_question_jobs
  SET status = 'processing',
      attempts = attempts + 1,
      lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
      last_error = NULL,
      updated_at = now()
  WHERE message_id = p_message_id
    AND conversation_id = p_conversation_id
    AND user_id = p_user_id
    AND (
      status IN ('queued', 'failed')
      OR (status = 'processing' AND lease_until < clock_timestamp())
    )
  RETURNING status INTO v_status;

  IF v_status IS NOT NULL THEN
    RETURN QUERY SELECT 'claimed'::text;
  ELSE
    RETURN QUERY SELECT 'processing'::text;
  END IF;
END;
$$;

-- drainer due-job 선별 (삼순 4차 P1). 처리 계열(queued/processing/failed)은 attempts,
-- 발송만 남은 ready는 delivery_attempts로 각각 bounded한다 — 5번째 처리에서 답변 생성이
-- 성공하고 발송만 일시 실패해도(ready, attempts=5) job이 영구 제외되지 않는다.
CREATE OR REPLACE FUNCTION public.due_baseball_genius_question_jobs(
  p_limit integer DEFAULT 5
)
RETURNS SETOF public.genius_question_jobs
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT *
  FROM public.genius_question_jobs
  WHERE lease_until < clock_timestamp()
    AND (
      (status IN ('queued', 'processing', 'failed') AND attempts < 5)
      OR (status = 'ready' AND delivery_attempts < 5)
    )
  ORDER BY created_at ASC
  LIMIT least(greatest(coalesce(p_limit, 5), 1), 50);
$$;

-- 발송 실패 기록: delivery_attempts 증가 + backoff lease. status는 ready를 유지해
-- 다음 drain이 저장된 답변으로 발송만 재시도한다. 반환값은 관측/알림 판단용.
CREATE OR REPLACE FUNCTION public.record_baseball_genius_delivery_failure(
  p_message_id bigint,
  p_backoff_seconds integer DEFAULT 60
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attempts integer;
BEGIN
  IF p_message_id IS NULL OR p_message_id < 1
     OR p_backoff_seconds < 5 OR p_backoff_seconds > 3600 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'invalid delivery failure record';
  END IF;

  UPDATE public.genius_question_jobs
  SET delivery_attempts = delivery_attempts + 1,
      lease_until = clock_timestamp() + make_interval(secs => p_backoff_seconds),
      last_error = 'dm_send_failed',
      updated_at = now()
  WHERE message_id = p_message_id AND status = 'ready'
  RETURNING delivery_attempts INTO v_attempts;

  RETURN coalesce(v_attempts, 0);
END;
$$;

ALTER TABLE public.baseball_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.genius_qa_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.genius_question_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.genius_daily_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.genius_question_jobs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON FUNCTION public.reserve_baseball_genius_daily_question(uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_baseball_genius_daily_question(uuid, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.claim_baseball_genius_question(bigint, uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_baseball_genius_question(bigint, uuid, uuid, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.reserve_baseball_genius_daily_question_for_message(bigint, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_baseball_genius_daily_question_for_message(bigint, uuid, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.due_baseball_genius_question_jobs(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.due_baseball_genius_question_jobs(integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.record_baseball_genius_delivery_failure(bigint, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_baseball_genius_delivery_failure(bigint, integer)
  TO service_role;
