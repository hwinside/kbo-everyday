-- 야잘알봇 마스코트 모션 쿨다운 원장 (SSOT §7.4 "모션 30초 1회").
--
-- 왜 원장인가 (삼순 #1202 1차 P0):
--   종전 구현은 `SELECT 직전 모션` → (별도 트랜잭션) 답변 INSERT 였다. 같은 유저의 두
--   메시지·두 worker 가 동시에 들어오면 **둘 다 같은 lastMotionAt 을 읽고 둘 다 모션을 붙여**
--   30초 1회를 깬다. positive ending 시그니처(20260814154000)와 정확히 같은 축이라
--   같은 형태 — 유저 advisory lock + message_id 멱등 + 판정 + 기록을 한 트랜잭션 — 로 닫는다.
--
-- 왜 **양방향** 인가 (삼순 #1202 2차 P0):
--   1차 구현은 기존 grant 를 `decided_at < p_decided_at` 로만 봤다. advisory lock 은
--   **처리 순서**만 직렬화할 뿐 도착 순서를 보장하지 않으므로, Q2(t+10ms)가 먼저 처리돼
--   grant 된 뒤 Q1(t)가 들어오면 Q1 은 "자기보다 과거의 grant"만 찾다가 Q2 를 못 보고
--   **둘 다 grant** 된다. 동일 timestamp 도 마찬가지다.
--   → 판정을 **|Δ| < 쿨다운**(동시각 포함 차단, 정확히 30초는 허용)으로 바꾼다.
--
-- 왜 EXCLUDE 제약까지 두는가:
--   판정 로직만으로는 "판정을 우회한 직접 INSERT"나 미래의 리팩터링 실수를 막지 못한다.
--   같은 유저의 granted 행이 30초 창에서 겹치는 것을 **물리적으로** 금지해 두면, 로직이
--   틀려도 이중 부여가 저장되지 않는다. 제약 위반은 예외로 터뜨리지 않고 **억제 판정으로
--   흡수**한다(경합에서 진 쪽은 "이미 최근에 나갔다"와 같은 의미다).
--
-- 멱등: message_id PK. durable ready 재시도·재처리는 **처음 내린 판정을 그대로 재생**한다
--   (재판정하면 재시도 시점에 따라 모션이 생겼다 사라진다 — #1197 ②③ 계약).
--
-- 판정 근거: 원장의 granted 행 + 호출자가 넘긴 실제 payload 기준 직전 모션 시각.
--   원장 도입 이전에 나간 모션도 쿨다운을 밀도록 payload 시각을 함께 받는다(원장만 보면
--   배포 직후 첫 답변이 무조건 모션을 받는다). 이 시각에도 같은 양방향 규칙을 적용한다.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS public.genius_motion_grants (
  message_id bigint PRIMARY KEY REFERENCES public.dm_messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  -- 부여된 모션. 억제된 경우 NULL 이며, 그 행은 쿨다운 기준에 쓰이지 않는다.
  motion text CHECK (motion IS NULL OR motion IN ('excited', 'headspin', 'bored')),
  granted boolean NOT NULL,
  -- 판정 기준 시각 = 질문 dm_messages.created_at (DB 고정값 — wall clock 아님).
  decided_at timestamptz NOT NULL,
  -- 쿨다운 창 종료 시각 = decided_at + 창. **저장 컬럼**이어야 한다 —
  -- `decided_at + interval` 은 STABLE 이라 인덱스/EXCLUDE 표현식에 직접 못 쓴다.
  cooldown_until timestamptz NOT NULL,
  CONSTRAINT genius_motion_grants_window_check CHECK (cooldown_until > decided_at),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT genius_motion_grants_motion_granted_check
    CHECK ((granted AND motion IS NOT NULL) OR (NOT granted AND motion IS NULL))
);

-- 쿨다운 조회는 "이 유저의 granted 행 중 ±30초"라 부분 인덱스로 양방향 범위를 닫는다.
CREATE INDEX IF NOT EXISTS idx_genius_motion_grants_user_granted
  ON public.genius_motion_grants (user_id, decided_at DESC, message_id DESC)
  WHERE granted;

-- 물리 안전망: 같은 유저의 granted 행이 30초 창에서 겹치면 저장 자체가 불가능하다.
--   [decided_at, cooldown_until) 반열림 구간이라 |Δ| = 30초는 겹치지 않고(허용),
--   |Δ| < 30초와 동시각은 겹친다(차단). 창 값은 RPC 가 p_cooldown_ms 로 채우므로
--   상수가 두 곳에 갈라지지 않는다.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'genius_motion_grants_cooldown_excl'
  ) THEN
    ALTER TABLE public.genius_motion_grants
      ADD CONSTRAINT genius_motion_grants_cooldown_excl
      EXCLUDE USING gist (
        user_id WITH =,
        tstzrange(decided_at, cooldown_until, '[)') WITH &&
      ) WHERE (granted);
  END IF;
END;
$$;

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
  v_window interval;
  v_conflict boolean;
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

  v_window := make_interval(secs => greatest(p_cooldown_ms, 1) / 1000.0);

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
    INSERT INTO public.genius_motion_grants(message_id, user_id, motion, granted, decided_at, cooldown_until)
    VALUES (p_message_id, p_user_id, NULL, false, p_decided_at, p_decided_at + v_window);
    RETURN QUERY SELECT NULL::text, false;
    RETURN;
  END IF;

  -- **양방향** 판정: 과거든 미래든 |Δ| < 창이면 억제한다(동시각 포함).
  --   정확히 창 크기(30초)는 `>`·`<` 가 아니라 경계 밖이므로 허용된다.
  SELECT EXISTS (
    SELECT 1
    FROM public.genius_motion_grants AS grant_row
    WHERE grant_row.user_id = p_user_id
      AND grant_row.granted
      AND grant_row.message_id <> p_message_id
      AND grant_row.decided_at > p_decided_at - v_window
      AND grant_row.decided_at < p_decided_at + v_window
  ) INTO v_conflict;

  IF NOT v_conflict AND p_payload_last_motion_at IS NOT NULL THEN
    v_conflict := p_payload_last_motion_at > p_decided_at - v_window
              AND p_payload_last_motion_at < p_decided_at + v_window;
  END IF;

  v_grant := NOT v_conflict;
  v_motion := CASE WHEN v_grant THEN p_motion ELSE NULL END;

  BEGIN
    INSERT INTO public.genius_motion_grants(message_id, user_id, motion, granted, decided_at, cooldown_until)
    VALUES (p_message_id, p_user_id, v_motion, v_grant, p_decided_at, p_decided_at + v_window);
  EXCEPTION WHEN exclusion_violation THEN
    -- 물리 제약이 이겼다 = 30초 창에 이미 부여된 grant 가 있다. 예외로 터뜨리지 않고
    -- 억제 판정으로 흡수한다(경합에서 진 쪽은 "이미 최근에 나갔다"와 같은 의미).
    v_grant := false;
    v_motion := NULL;
    INSERT INTO public.genius_motion_grants(message_id, user_id, motion, granted, decided_at, cooldown_until)
    VALUES (p_message_id, p_user_id, NULL, false, p_decided_at, p_decided_at + v_window);
  END;

  RETURN QUERY SELECT v_motion, v_grant;
END;
$$;

ALTER TABLE public.genius_motion_grants ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.genius_motion_grants FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_baseball_genius_motion(bigint, uuid, text, timestamptz, integer, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_baseball_genius_motion(bigint, uuid, text, timestamptz, integer, timestamptz)
  TO service_role;
