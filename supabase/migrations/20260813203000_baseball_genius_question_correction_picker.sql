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
      'accepted_surface','suggested','accepted_user','declined','rejected','no_change','error'
    )
  );

-- 제안만 한 후보는 **별도 칸**에 남긴다 (삼순 2026-08-13 ③).
-- `question_normalized` 는 "수용된 문장" 전용 계약(20260811210000 주석)이라,
-- 유저가 고르지도 않은 후보를 거기 넣으면 "이 문장으로 답했다" 와 "제안만 했다" 가
-- 구분되지 않아 오교정 감사의 분모가 무너진다.
ALTER TABLE public.genius_question_logs
  ADD COLUMN IF NOT EXISTS question_correction_candidate text;

COMMENT ON COLUMN public.genius_question_logs.question_correction_candidate IS
  'Tier B 교정 후보를 유저에게 제안한 경우의 후보문(질문으로 쓴 적 없음). 수용된 문장은 question_normalized 에만 들어간다.';

ALTER TABLE public.genius_question_jobs
  ADD COLUMN IF NOT EXISTS picked_normalized_question text,
  ADD COLUMN IF NOT EXISTS correction_options jsonb,
  ADD COLUMN IF NOT EXISTS correction_question_message_id bigint,
  ADD COLUMN IF NOT EXISTS correction_declined boolean NOT NULL DEFAULT false;

-- 제안 카드 발행을 **한 트랜잭션으로** 결정한다: quota 반납 + 후보 durable 저장 + ready 전환.
--
-- 🔴 직전 회차 결손(삼순 2026-08-13 quota/crash): pipeline 이 `releaseDaily` 를 후보를 job 에
--    저장하기 **전에** 불렀고 오류도 삼켤다. 그 창에서 crash 하면
--      · 반납만 되고 제안이 안 저장됨 → cron 재개 시 `quota_reserved=true` 라 reserve 가
--        재차감 없이 통과해 최종 답변이 `used=0` 으로 나간다(무료 질문).
--      · 반납이 실패했는데 삼켜지면 카드는 나가고 `used=1` 이 남는다(이중 과금).
--    둘을 같은 트랜잭션에 묶으면 중간 상태 자체가 존재할 수 없다 — 둘 다 되거나 둘 다 안 된다.
CREATE OR REPLACE FUNCTION public.settle_baseball_genius_correction_suggestion(
  p_message_id bigint,
  p_user_id uuid,
  p_answer text,
  p_correction_option text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job public.genius_question_jobs%ROWTYPE;
  v_day date;
  v_changed integer;
BEGIN
  IF p_message_id IS NULL OR p_message_id < 1 OR p_user_id IS NULL
     OR nullif(btrim(p_correction_option), '') IS NULL
     OR length(p_correction_option) > 200
     OR nullif(btrim(p_answer), '') IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'invalid correction suggestion';
  END IF;

  SELECT * INTO v_job
  FROM public.genius_question_jobs
  WHERE message_id = p_message_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'genius question job missing';
  END IF;

  -- 반납은 release RPC 와 **같은 계약**이다(예약된 적 없거나 이미 반납 = 멱등 no-op,
  -- 반납은 예약했던 바로 그 날짜 버킷에서). 다른 곳에 복사하지 않고 여기서 바로 한다 —
  -- 별도 호출로 나누는 순간 다시 분리 가능한 두 쓰기가 된다.
  IF v_job.quota_reserved AND NOT v_job.quota_released
     AND coalesce(v_job.quota_allowed, false) = true THEN
    v_day := coalesce(
      v_job.quota_kst_day,
      (clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date
    );
    UPDATE public.genius_daily_usage
    SET used = greatest(0, used - 1), updated_at = now()
    WHERE user_id = p_user_id AND kst_day = v_day;
  END IF;

  UPDATE public.genius_question_jobs
  SET status = 'ready',
      answer = p_answer,
      source = 'question_correction',
      remaining = v_job.quota_remaining,
      correction_options = jsonb_build_array(p_correction_option),
      correction_question_message_id = p_message_id,
      -- 반납을 이 행에 함께 기록해야 선택/거절 RPC 가 "예약을 새로 열지"를 맞게 판정한다.
      quota_released = CASE
        WHEN v_job.quota_reserved AND coalesce(v_job.quota_allowed, false) = true THEN true
        ELSE v_job.quota_released
      END,
      updated_at = now()
  WHERE message_id = p_message_id
    AND status = 'processing';
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_baseball_genius_correction_suggestion(bigint, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_baseball_genius_correction_suggestion(bigint, uuid, text, text)
  TO service_role;

-- 교정 제안 응답을 원자로 고정한다. `p_picked_normalized_question IS NULL` = **거절**(원문 진행).
--
-- ⚠️ 핵심은 `status = 'awaiting_selection'` 조건이다 (삼순 2026-08-13 ① · 2탭/재전송 방어).
--   첫 탭이 이 행을 `queued` 로 바꾸므로 둘째 탭은 UPDATE 를 0행 맞고, 아래 EXISTS 가
--   **같은 응답일 때만** true 를 돌려준다. 즉 다른 응답으로 덮어쓰는 두 번째 탭은
--   거절되고(400), 같은 응답의 재시도는 멱등하게 통과한다 — 후속 질문·과금 정확히 1건.
--
-- quota 계약은 picker 와 동일하다: 제안 단계에서 반납됐으면(`quota_released`) 최종 답변용
-- 예약을 새로 열고, 반납이 실패했으면 기존 1회를 그대로 재사용한다. 어느 경우든
-- `제안 0 + 최종 1` 을 넘지 않는다.
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
  v_declined boolean := p_picked_normalized_question IS NULL;
BEGIN
  IF p_message_id IS NULL OR p_message_id < 1 OR p_user_id IS NULL
     OR (NOT v_declined AND (
           nullif(btrim(p_picked_normalized_question), '') IS NULL
           OR length(p_picked_normalized_question) > 200)) THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'invalid question correction';
  END IF;

  UPDATE public.genius_question_jobs
  SET picked_normalized_question = p_picked_normalized_question,
      correction_declined = v_declined,
      status = 'queued',
      lease_until = clock_timestamp(),
      answer = NULL,
      source = NULL,
      remaining = NULL,
      correction_options = NULL,
      correction_question_message_id = NULL,
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
    -- 거절은 제안이 실제로 있었을 때만, 선택은 **서버가 발급한 exact 후보**일 때만 받는다.
    AND (
      (v_declined AND correction_options IS NOT NULL)
      OR correction_options = jsonb_build_array(p_picked_normalized_question)
    );
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed = 1 THEN RETURN true; END IF;

  -- 멱등 재시도: **같은 응답**이 이미 고정된 경우에만 true. 다른 응답(2탭 경합)은 false.
  RETURN EXISTS (
    SELECT 1 FROM public.genius_question_jobs
    WHERE message_id = p_message_id AND user_id = p_user_id
      AND correction_declined = v_declined
      AND picked_normalized_question IS NOT DISTINCT FROM p_picked_normalized_question
      AND status IN ('queued', 'processing', 'ready', 'completed')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_baseball_genius_question_correction(bigint, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_baseball_genius_question_correction(bigint, uuid, text)
  TO service_role;
