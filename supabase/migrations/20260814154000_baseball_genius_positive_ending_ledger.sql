-- 야잘알봇 positive ending 시그니처 cooldown 원장.
-- 같은 유저의 병렬 ACK도 판정→시그니처 부착→기록을 한 트랜잭션으로 직렬화한다.

CREATE TABLE IF NOT EXISTS public.genius_positive_endings (
  message_id bigint PRIMARY KEY REFERENCES public.dm_messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  answer text NOT NULL CHECK (length(answer) > 0),
  used_signature boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_genius_positive_endings_user_recent
  ON public.genius_positive_endings (user_id, created_at DESC, message_id DESC);

CREATE OR REPLACE FUNCTION public.claim_baseball_genius_positive_ending(
  p_message_id bigint,
  p_user_id uuid,
  p_base_answer text
)
RETURNS TABLE(answer text, used_signature boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing public.genius_positive_endings%ROWTYPE;
  v_used_recently boolean;
  v_use_signature boolean;
  v_answer text;
BEGIN
  IF p_message_id IS NULL OR p_message_id < 1 OR p_user_id IS NULL
     OR nullif(btrim(p_base_answer), '') IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'invalid genius positive ending claim';
  END IF;

  -- 유저별 transaction lock. 서로 다른 message_id의 동시 ACK도 이 지점에서 직렬화된다.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 1186));

  SELECT * INTO v_existing
  FROM public.genius_positive_endings AS ending
  WHERE ending.message_id = p_message_id;
  IF FOUND THEN
    IF v_existing.user_id <> p_user_id THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'positive ending claim owner mismatch';
    END IF;
    RETURN QUERY SELECT v_existing.answer, v_existing.used_signature;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM (
      SELECT ending.used_signature
      FROM public.genius_positive_endings AS ending
      WHERE ending.user_id = p_user_id
      ORDER BY ending.created_at DESC, ending.message_id DESC
      LIMIT 5
    ) AS recent
    WHERE recent.used_signature
  ) INTO v_used_recently;

  v_use_signature := NOT v_used_recently;
  v_answer := CASE
    WHEN v_use_signature THEN p_base_answer || E'\n승리를 위하여!'
    ELSE p_base_answer
  END;

  INSERT INTO public.genius_positive_endings(message_id, user_id, answer, used_signature)
  VALUES (p_message_id, p_user_id, v_answer, v_use_signature);

  RETURN QUERY SELECT v_answer, v_use_signature;
END;
$$;

ALTER TABLE public.genius_positive_endings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.genius_positive_endings FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_baseball_genius_positive_ending(bigint, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_baseball_genius_positive_ending(bigint, uuid, text)
  TO service_role;
