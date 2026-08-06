-- 야잘알봇 답변 품질 피드백 적재 (하린아빠 2026-08-05 18:03/18:09 명시).
--
-- 범위는 **적재까지만**이다. 피드백을 캐시·사전·골든셋·few-shot 으로 승격하거나
-- 답변 라우팅에 되먹이는 자동화 루프는 하린아빠 HOLD 상태다(2026-08-05 18:02).
-- 이 migration 은 기존 답변·라우팅·캐시 경로를 한 줄도 바꾸지 않는다.
--
-- 계약 (삼순 2026-08-05 18:07):
--   ① 답변/질문로그 exact 결속  ② 사용자당 1표
--   ③ 재선택 = 변경, 재클릭 = 취소  ④ 중복 적재 방지  ⑤ 본인 데이터만 쓰기

-- ── ① 질문 로그 ↔ 질문 쪽지 exact 결속 ────────────────────────────────────────
-- 지금까지 `genius_question_logs` 는 (user_id, question_norm, created_at) 뿐이라
-- **어떤 쪽지에 대한 로그인지 특정할 수 없었다**. 같은 유저가 같은 질문을 두 번 하면
-- 두 행이 구분되지 않아, 피드백을 로그에 붙이려면 시간창 추정을 해야 한다.
-- 추정 결속은 오적재를 만든다 — 질문 쪽지 id 를 그대로 적어 exact 로 만든다.
--
-- NULL 을 허용하는 이유: 이 컬럼이 생기기 전 로그가 이미 쌓여 있고, backfill 할
-- 근거가 없다(그 로그들은 어느 쪽지인지 실제로 모른다). 없는 값을 지어내지 않는다.
ALTER TABLE public.genius_question_logs
  ADD COLUMN IF NOT EXISTS question_message_id bigint;

CREATE INDEX IF NOT EXISTS idx_genius_question_logs_question_message
  ON public.genius_question_logs (question_message_id)
  WHERE question_message_id IS NOT NULL;

-- ── ② 피드백 원장 ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.genius_answer_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  -- 유저가 실제로 누른 대상 = 답변 쪽지. dm_messages 가 지워지면 피드백도 의미가 없다.
  answer_message_id bigint NOT NULL REFERENCES public.dm_messages(id) ON DELETE CASCADE,
  -- 분석 결속: 이 답변이 어느 질문에 대한 것인지. 답변 쪽지에서 역산하지 않고 명시 저장한다
  -- (dedup_key 문자열 파싱은 접두 규칙이 바뀌는 순간 조용히 깨진다).
  question_message_id bigint,
  -- 당시 라우팅 경로 **스냅샷**. 나중에 경로가 바뀌어도 "그때 그 답변"의 품질로 읽어야 한다.
  -- FK 를 걸지 않는 이유: match_path allowlist 는 앞으로도 확장되고, 과거 스냅샷이
  -- 새 CHECK 때문에 막히면 안 된다. 여기서는 관측값이지 제약 대상이 아니다.
  match_path text,
  -- 1 = 좋아요, -1 = 별로. 0(중립)은 만들지 않는다 — 취소는 행 삭제다.
  rating smallint NOT NULL CHECK (rating IN (1, -1)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 사용자당 1표 + 중복 적재 방지를 **DB 제약으로** 강제한다.
-- 애플리케이션 조건문만으로는 동시 탭/재시도에서 두 행이 들어온다.
CREATE UNIQUE INDEX IF NOT EXISTS uq_genius_answer_feedback_user_answer
  ON public.genius_answer_feedback (user_id, answer_message_id);

CREATE INDEX IF NOT EXISTS idx_genius_answer_feedback_created
  ON public.genius_answer_feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_genius_answer_feedback_rating
  ON public.genius_answer_feedback (rating, created_at DESC);

-- ── ③ RLS: 전면 차단 (service_role 전용) ──────────────────────────────────────
-- 클라는 이 테이블에 직접 접근하지 않는다. 모든 읽기/쓰기는 인증을 검증한
-- 서버 route 를 통과한다 (poll_votes 와 동일한 패턴).
ALTER TABLE public.genius_answer_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.genius_answer_feedback FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.genius_answer_feedback FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.genius_answer_feedback FROM authenticated;
  END IF;
  REVOKE ALL ON public.genius_answer_feedback FROM PUBLIC;
END $$;

-- ── ④ 토글 RPC (변경/취소를 한 statement 원자로) ──────────────────────────────
-- 왜 RPC 인가: "같은 값이면 취소, 다른 값이면 변경"을 클라나 route 에서
-- SELECT → 분기 → WRITE 로 구현하면 두 탭이 동시에 누를 때 read-modify-write 경합이
-- 생겨 마지막 상태가 비결정적이 된다. 단일 statement 로 DB 안에서 판정한다.
--
-- 반환값 = 이 유저의 **최종 상태**. NULL 이면 표를 취소한 것이다.
-- 호출자(route)는 이미 소유권(이 답변이 이 유저의 야잘알봇 대화 것인지)을 검증한 뒤
-- 호출한다 — 이 함수는 소유권을 스스로 판단하지 않는다.
CREATE OR REPLACE FUNCTION public.set_baseball_genius_answer_feedback(
  p_user_id uuid,
  p_answer_message_id bigint,
  p_question_message_id bigint,
  p_match_path text,
  p_rating smallint
)
RETURNS smallint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing smallint;
BEGIN
  IF p_rating IS NULL OR p_rating NOT IN (1, -1) THEN
    RAISE EXCEPTION 'invalid rating: %', p_rating;
  END IF;

  -- 같은 값 재클릭 = 취소. 행 자체를 지운다(중립 상태를 별도 값으로 남기지 않는다).
  DELETE FROM genius_answer_feedback
   WHERE user_id = p_user_id
     AND answer_message_id = p_answer_message_id
     AND rating = p_rating
  RETURNING rating INTO v_existing;
  IF FOUND THEN
    RETURN NULL;
  END IF;

  -- 신규 또는 변경. unique 제약이 사용자당 1표를 보장하므로 ON CONFLICT 로 흡수한다.
  INSERT INTO genius_answer_feedback (
    user_id, answer_message_id, question_message_id, match_path, rating
  )
  VALUES (
    p_user_id, p_answer_message_id, p_question_message_id, p_match_path, p_rating
  )
  ON CONFLICT (user_id, answer_message_id) DO UPDATE
    SET rating = EXCLUDED.rating,
        -- 결속 메타는 처음 값이 정본이다. 재투표가 NULL 로 덮어쓰지 않게 COALESCE.
        question_message_id = COALESCE(genius_answer_feedback.question_message_id, EXCLUDED.question_message_id),
        match_path = COALESCE(genius_answer_feedback.match_path, EXCLUDED.match_path),
        updated_at = now();

  RETURN p_rating;
END;
$$;

REVOKE ALL ON FUNCTION public.set_baseball_genius_answer_feedback(uuid, bigint, bigint, text, smallint) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.set_baseball_genius_answer_feedback(uuid, bigint, bigint, text, smallint) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.set_baseball_genius_answer_feedback(uuid, bigint, bigint, text, smallint) FROM authenticated;
  END IF;
END $$;
