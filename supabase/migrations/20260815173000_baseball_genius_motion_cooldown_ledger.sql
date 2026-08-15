-- 야잘알봇 마스코트 모션 쿨다운 원장 (SSOT §7.4 "모션 30초 1회").
--
-- 왜 원장인가 (삼순 #1202 P0):
--   종전 구현은 `SELECT 직전 모션` → (별도 트랜잭션) 답변 INSERT 였다. 같은 유저의 두
--   메시지·두 worker 가 동시에 들어오면 **둘 다 같은 lastMotionAt 을 읽고 둘 다 모션을 붙여**
--   30초 1회를 깬다. positive ending 시그니처(20260814154000)와 정확히 같은 축이라
--   같은 형태 — 유저 advisory lock + message_id 멱등 + 판정 + 기록을 한 트랜잭션 — 로 닫는다.
--
-- 멱등: message_id PK. durable ready 재시도·재처리는 **처음 내린 판정을 그대로 재생**한다
--   (재판정하면 재시도 시점에 따라 모션이 생겼다 사라진다 — #1197 ②③ 계약).
--
-- 판정 근거: 원장의 직전 **부여된**(granted) 행 시각과, 호출자가 넘긴 실제 payload 기준
--   직전 모션 시각 중 **더 최근** 값. 원장 도입 이전에 나간 모션도 쿨다운을 밀도록
--   payload 시각을 함께 받는다(원장만 보면 배포 직후 첫 답변이 무조건 모션을 받는다).

CREATE TABLE IF NOT EXISTS public.genius_motion_grants (
  message_id bigint PRIMARY KEY REFERENCES public.dm_messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  -- 부여된 모션. 억제된 경우 NULL 이며, 그 행은 쿨다운 기준에 쓰이지 않는다.
  motion text CHECK (motion IS NULL OR motion IN ('excited', 'headspin', 'bored')),
  granted boolean NOT NULL,
  -- 판정 기준 시각 = 질문 dm_messages.created_at (DB 고정값 — wall clock 아님).
  decided_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT genius_motion_grants_motion_granted_check
    CHECK ((granted AND motion IS NOT NULL) OR (NOT granted AND motion IS NULL))
);

-- 쿨다운 조회는 "이 유저의 부여된 최근 1건"이라 부분 인덱스로 상수 시간에 닫는다.
CREATE INDEX IF NOT EXISTS idx_genius_motion_grants_user_granted
  ON public.genius_motion_grants (user_id, decided_at DESC, message_id DESC)
  WHERE granted;

CREATE OR REPLACE FUNCTION public.claim_baseball_genius_motion(
  p_message_id bigint,
  p_user_id uuid,
  p_motion text,
  p_decided_at timestamptz,
  p_cooldown_ms integer,
  p_payload_last_motion_at timestamptz DEFAULT NULL
)
RETURNS TABLE(motion text, granted boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing public.genius_motion_grants%ROWTYPE;
  v_last_at timestamptz;
  v_grant boolean;
  v_motion text;
BEGIN
  IF p_message_id IS NULL OR p_message_id < 1 OR p_user_id IS NULL
     OR p_decided_at IS NULL OR p_cooldown_ms IS NULL OR p_cooldown_ms < 0 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'invalid genius motion claim';
  END IF;
  IF p_motion IS NOT NULL AND p_motion NOT IN ('excited', 'headspin', 'bored') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'unknown genius motion';
  END IF;

  -- 유저별 transaction lock. 서로 다른 message_id 의 동시 요청도 여기서 직렬화된다.
  -- positive ending(1186)과 다른 키를 써야 두 기능이 서로를 막지 않는다.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 1202));

  -- 멱등: 이미 판정한 message_id 는 그 판정을 그대로 재생한다(durable 재시도 안정).
  SELECT * INTO v_existing
  FROM public.genius_motion_grants AS grant_row
  WHERE grant_row.message_id = p_message_id;
  IF FOUND THEN
    IF v_existing.user_id <> p_user_id THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'genius motion claim owner mismatch';
    END IF;
    RETURN QUERY SELECT v_existing.motion, v_existing.granted;
    RETURN;
  END IF;

  IF p_motion IS NULL THEN
    -- 모션 대상이 아닌 답변(지식·오류 등)은 기록만 남기고 쿨다운을 밀지 않는다.
    INSERT INTO public.genius_motion_grants(message_id, user_id, motion, granted, decided_at)
    VALUES (p_message_id, p_user_id, NULL, false, p_decided_at);
    RETURN QUERY SELECT NULL::text, false;
    RETURN;
  END IF;

  -- 쿨다운 기준 = 원장의 직전 부여 시각과 호출자가 준 payload 시각 중 더 최근 값.
  -- ⚠️ ORDER BY + LIMIT 가 붙은 SELECT 를 UNION 하려면 각 분기를 괄호로 감싸야 한다
  --    (그렇지 않으면 ORDER BY 가 UNION 전체에 걸린 것으로 파싱돼 syntax error).
  SELECT max(candidates.candidate) INTO v_last_at
  FROM (
    (
      SELECT grant_row.decided_at AS candidate
      FROM public.genius_motion_grants AS grant_row
      WHERE grant_row.user_id = p_user_id
        AND grant_row.granted
        AND grant_row.decided_at < p_decided_at
      ORDER BY grant_row.decided_at DESC, grant_row.message_id DESC
      LIMIT 1
    )
    UNION ALL
    (
      SELECT p_payload_last_motion_at AS candidate
      WHERE p_payload_last_motion_at IS NOT NULL
        AND p_payload_last_motion_at < p_decided_at
    )
  ) AS candidates;

  v_grant := v_last_at IS NULL
    OR (p_decided_at - v_last_at) >= make_interval(secs => p_cooldown_ms / 1000.0);
  v_motion := CASE WHEN v_grant THEN p_motion ELSE NULL END;

  INSERT INTO public.genius_motion_grants(message_id, user_id, motion, granted, decided_at)
  VALUES (p_message_id, p_user_id, v_motion, v_grant, p_decided_at);

  RETURN QUERY SELECT v_motion, v_grant;
END;
$$;

ALTER TABLE public.genius_motion_grants ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.genius_motion_grants FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_baseball_genius_motion(bigint, uuid, text, timestamptz, integer, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_baseball_genius_motion(bigint, uuid, text, timestamptz, integer, timestamptz)
  TO service_role;
