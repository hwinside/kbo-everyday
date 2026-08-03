-- 야잘알봇 동명이인 선수 picker (하린아빠 2026-08-03 지시).
--
-- 로스터 880명 중 32그룹 72명이 동명이인이고, 그중 7그룹은 **같은 팀에도** 동명이인이 있다
-- (김민준·김태훈·김현수·박준영·이서준·이승현·이주형). 이름만으로는 kboId를 특정할 수 없으므로
-- 추측해서 답하지 않고 선택지를 되물은 뒤, 유저가 고른 kboId로 문서를 특정해 답한다.
--
-- 이 migration 이 하는 일은 둘이다.
--   ① match_path allowlist 에 'player_picker' 추가
--   ② 되묻기에 소비된 하루 quota 를 되돌리는 멱등 RPC 추가

-- ── ① 로그 라벨 ────────────────────────────────────────────────────────────────
-- 되묻기는 답변이 아니라 **명확화 질문**이다. blocked 로 뭉뚱그리면 어드민 모니터(#983)에서
-- "못 답한 질문"으로 오집계되어, 실제로는 잘 동작하는 경로가 실패로 보인다.
-- 이 CHECK 확장이 없으면 picker 로그 INSERT 가 제약 위반으로 실패해 job 이 failed 로 떨어진다.
ALTER TABLE public.genius_question_logs
  DROP CONSTRAINT IF EXISTS genius_question_logs_match_path_check;
ALTER TABLE public.genius_question_logs
  ADD CONSTRAINT genius_question_logs_match_path_check CHECK (
    match_path IN (
      'dictionary','cache','llm','service_redirect','history_hold',
      'blocked','unsure','limited','error','context_missing','ack','rag',
      'player_picker','kbo_structured'
    )
  );
-- `kbo_structured` = 시즌 기록(수치)을 운영 DB 원값으로 답한 경로.
-- LLM·RAG·cache 를 전혀 쓰지 않으므로 생성답(llm)·근거답(rag)과 리스크가 다르다.
-- 뜻뭇그려 llm 로 넣으면 어드민 모니터(#983)에서 모델 생성답과 구분이 안 된다.

-- ── ② 선택된 선수 고정 ──────────────────────────────────────────────
-- 유저의 선택을 job 행에 고정해야 브라우저가 죽어도 cron drain 이 같은 선수로 이어서 답한다.
-- 이게 없으면 재처리 시 picker 가 다시 뜨면서 유저 입장에선 고른 게 사라진다.
ALTER TABLE public.genius_question_jobs
  ADD COLUMN IF NOT EXISTS picked_player_kbo_id text;

ALTER TABLE public.genius_question_jobs
  ADD COLUMN IF NOT EXISTS picker_options jsonb,
  ADD COLUMN IF NOT EXISTS picker_question_message_id bigint;

ALTER TABLE public.genius_question_jobs
  DROP CONSTRAINT IF EXISTS genius_question_jobs_status_check;
ALTER TABLE public.genius_question_jobs
  ADD CONSTRAINT genius_question_jobs_status_check CHECK (
    status IN ('queued', 'processing', 'ready', 'awaiting_selection', 'completed', 'failed')
  );

-- ── ③ quota 반납 ──────────────────────────────────────────────────────────────
-- quota 는 라우팅보다 먼저 예약된다(durable idempotent 계약). 되묻기도 그 예약을 이미
-- 소비한 뒤에 결정되므로, 그대로 두면 동명이인 선수는 "어느 선수?" 1개 + 실제 답변 1개로
-- 하루 한도를 두 배 쓴다. 하린아빠 승인 A안 = picker 무료, 선택 후 답변에서만 1개 차감.
--
-- ⚠️ 멱등성이 핵심이다. 발송 재시도·다중 worker 로 이 RPC 가 여러 번 불릴 수 있는데 그때마다
-- 감소시키면 유저가 한도를 무한히 회복한다. quota_released 플래그로 message_id 당 정확히
-- 1회만 반영한다.
ALTER TABLE public.genius_question_jobs
  ADD COLUMN IF NOT EXISTS quota_released boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.release_baseball_genius_daily_question_for_message(
  p_message_id bigint,
  p_user_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job public.genius_question_jobs%ROWTYPE;
  v_used integer;
BEGIN
  IF p_message_id IS NULL OR p_message_id < 1 OR p_user_id IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'invalid message quota release';
  END IF;

  SELECT * INTO v_job
  FROM public.genius_question_jobs
  WHERE message_id = p_message_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'genius question job missing';
  END IF;

  -- 예약된 적 없거나(무료 경로) 이미 반납했으면 아무것도 하지 않는다 (멱등).
  -- quota_allowed=false 는 한도 초과로 애초에 차감되지 않은 경우다 — 반납 대상이 아니다.
  IF NOT v_job.quota_reserved OR v_job.quota_released
     OR coalesce(v_job.quota_allowed, false) = false THEN
    RETURN 0;
  END IF;

  UPDATE public.genius_daily_usage
  SET used = greatest(0, used - 1), updated_at = now()
  WHERE user_id = p_user_id
    AND kst_day = (clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date
  RETURNING used INTO v_used;

  -- 자정을 넘겨 해당 일자 행이 없으면 되돌릴 대상이 없다. 그래도 released 로 고정해
  -- 나중에 엉뚱한 날짜에 반납되지 않게 한다.
  UPDATE public.genius_question_jobs
  SET quota_released = true, updated_at = now()
  WHERE message_id = p_message_id;

  RETURN 1;
END;
$$;

REVOKE ALL ON FUNCTION public.release_baseball_genius_daily_question_for_message(bigint, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_baseball_genius_daily_question_for_message(bigint, uuid)
  TO service_role;

-- picker 선택을 원 질문 job에 원자 고정하고 최종 답변용 quota 예약을 새로 연다.
CREATE OR REPLACE FUNCTION public.prepare_baseball_genius_player_selection(
  p_message_id bigint,
  p_user_id uuid,
  p_picked_player_kbo_id text
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
     OR nullif(btrim(p_picked_player_kbo_id), '') IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'invalid player selection';
  END IF;

  UPDATE public.genius_question_jobs
  SET picked_player_kbo_id = p_picked_player_kbo_id,
      status = 'queued',
      lease_until = clock_timestamp(),
      answer = NULL,
      source = NULL,
      remaining = NULL,
      picker_options = NULL,
      picker_question_message_id = NULL,
      -- release 성공이면 최종답변용으로 새 예약을 열고, release 실패면 기존 1회를 재사용한다.
      -- 어느 경우에도 picker+최종답변 합계가 1회를 넘지 않는다.
      quota_reserved = CASE WHEN quota_released THEN false ELSE quota_reserved END,
      quota_allowed = CASE WHEN quota_released THEN NULL ELSE quota_allowed END,
      quota_remaining = CASE WHEN quota_released THEN NULL ELSE quota_remaining END,
      quota_released = false,
      delivery_attempts = 0,
      last_error = NULL,
      updated_at = now()
  WHERE message_id = p_message_id
    AND user_id = p_user_id
    AND status = 'awaiting_selection';
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed = 1 THEN RETURN true; END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.genius_question_jobs
    WHERE message_id = p_message_id AND user_id = p_user_id
      AND picked_player_kbo_id = p_picked_player_kbo_id
      AND status IN ('queued', 'processing', 'ready', 'completed')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_baseball_genius_player_selection(bigint, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_baseball_genius_player_selection(bigint, uuid, text)
  TO service_role;
