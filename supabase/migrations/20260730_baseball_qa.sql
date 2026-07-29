-- 야구천재 고정 DM Q&A MVP (Notion SSOT v1.2)
-- ⚠️ 운영 DB 직접 적용 금지 — 머지 게이트 후 시스템 계정 프로비저닝과 함께 적용.

CREATE TABLE IF NOT EXISTS public.baseball_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term text NOT NULL UNIQUE,
  aliases text[] NOT NULL DEFAULT '{}',
  answer text NOT NULL,
  category text NOT NULL DEFAULT 'rule',
  source_url text NOT NULL,
  rule_version text NOT NULL,
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

ALTER TABLE public.baseball_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.genius_qa_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.genius_question_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.genius_daily_usage ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON FUNCTION public.reserve_baseball_genius_daily_question(uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_baseball_genius_daily_question(uuid, integer)
  TO service_role;
