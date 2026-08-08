-- 야잘알봇 답변 품질 피드백 적재 (하린아빠 2026-08-05 18:03/18:09 명시).
--
-- 범위는 **적재까지만**이다. 피드백을 캐시·사전·골든셋·few-shot 으로 승격하거나
-- 답변 라우팅에 되먹이는 자동화 루프는 하린아빠 HOLD 상태다(2026-08-05 18:02).
-- 이 migration 은 기존 답변·라우팅·캐시 경로를 한 줄도 바꾸지 않는다.
--
-- 대상 (하린아빠 2026-08-06 16:36/16:37 최종):
--   "스몰톡은 넣지마. 대화가 자연스러워지지 않아. … **RAG를 통해 정보를 가져와
--    답변한 것들에 한해서** 해" + "아.. **사전에서 가져온 답변 추가**"
--   ⇒ `match_path IN ('rag','dictionary')` 이고 실제로 답변으로 나간 것만.
--
-- 계약 (삼순 2026-08-05 18:07 + 08-06 재리뷰):
--   ① 답변↔질문↔질문로그 exact 결속을 **DB 제약으로**  ② 사용자당 1표
--   ③ CAS 로 병렬/재전송 안전  ④ 중복 적재 방지  ⑤ 본인 데이터만 쓰기

-- ── ① 질문 로그 ↔ 질문 쪽지 결속 ─────────────────────────────────────────────
-- 지금까지 `genius_question_logs` 는 (user_id, question_norm, created_at) 뿐이라
-- **어떤 쪽지에 대한 로그인지 특정할 수 없었다**. 같은 유저가 같은 질문을 두 번 하면
-- 두 행이 구분되지 않아, 피드백을 로그에 붙이려면 시간창 추정을 해야 한다.
-- 추정 결속은 오적재를 만든다 — 질문 쪽지 id 를 그대로 적어 exact 로 만든다.
--
-- NULL 을 허용하는 이유: 이 컬럼이 생기기 전 로그가 이미 쌓여 있고, backfill 할
-- 근거가 없다(그 로그들은 어느 쪽지인지 실제로 모른다). 없는 값을 지어내지 않는다.
--
-- ⚠️ `question_message_id` 에 UNIQUE 를 걸지 **않는다**. 동명이인 picker 흐름은
-- 같은 질문 쪽지 하나로 `player_picker` 로그를 남긴 뒤, 유저가 선수를 고르면 같은
-- messageId 로 재처리되어 최종 답(`rag` 등) 로그를 한 번 더 남긴다. UNIQUE 를 걸면
-- 그 두 번째 INSERT 가 죽어 **최종 답변 로그가 통째로 사라진다**(실측: pipeline.ts
-- 1768줄 player_picker 로그 → pickBaseballQaPlayer 재처리 → 1595/1681줄 rag 로그).
-- 대신 결속은 아래 `question_log_id` FK 로 행 단위로 못박고, route 가 `(user_id,
-- question_message_id, match_path)` 로 **정확히 1행**일 때만 통과시킨다(0/N 은 fail-close).
ALTER TABLE public.genius_question_logs
  ADD COLUMN IF NOT EXISTS question_message_id bigint;

CREATE INDEX IF NOT EXISTS idx_genius_question_logs_question_message
  ON public.genius_question_logs (question_message_id, match_path)
  WHERE question_message_id IS NOT NULL;

-- ── ② 피드백 원장 ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.genius_answer_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  -- 유저가 실제로 누른 대상 = 답변 쪽지. dm_messages 가 지워지면 피드백도 의미가 없다.
  answer_message_id bigint NOT NULL REFERENCES public.dm_messages(id) ON DELETE CASCADE,
  -- 원 질문 쪽지. **NOT NULL + FK** 다 — 어느 질문에 대한 평가인지 모르는 표는 만들지 않는다.
  -- (대상이 앞으로 나갈 rag/dictionary 답변뿐이라 legacy 호환을 위한 NULL 이 필요 없다.
  --  qid 가 없는 과거 답변은 UI 가 버튼 자체를 안 그리고 route 도 400 으로 막는다.)
  question_message_id bigint NOT NULL REFERENCES public.dm_messages(id) ON DELETE CASCADE,
  -- 질문 로그 exact 결속 (삼순 2차 blocker ③). 시간창 추정이 아니라 FK 다.
  -- route 가 (user_id, question_message_id, match_path) 로 정확히 1행을 찾았을 때만 채워진다.
  question_log_id uuid NOT NULL REFERENCES public.genius_question_logs(id) ON DELETE CASCADE,
  -- 당시 라우팅 경로 **스냅샷**. 나중에 경로가 바뀌어도 "그때 그 답변"의 품질로 읽어야 한다.
  match_path text NOT NULL,
  -- 응답 종류 스냅샷. 대상은 `answer` 뿐이지만, 나중에 대상이 넓어져도 지표를 섞지 않으려면
  -- 표마다 종류가 같이 남아 있어야 한다.
  reply_kind text NOT NULL,
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

-- ── ④ CAS 토글 RPC ───────────────────────────────────────────────────────────
-- 왜 RPC 인가: "지금 상태에서 이 상태로 바꾼다"를 route 에서 SELECT → 분기 → WRITE 로
-- 구현하면 두 탭이 동시에 누를 때 read-modify-write 경합이 생겨 결과가 비결정적이 된다.
--
-- **왜 CAS(비교 후 교체)인가** (삼순 08-06 재리뷰 P0):
--   직전 구현은 `p_expected_prev = p_rating` 이면 무조건 DELETE 하고 **DELETE 0행이어도
--   NULL 을 반환**했다. 그래서 다른 탭이 DB 를 👎 로 바꾼 뒤 stale 👍 취소가 도착하면
--   **DB 에는 👎 가 남는데 API/UI 는 미투표(NULL)** 로 갈라졌다. 취소가 "무조건 성공"이
--   아니라 "내가 보던 상태였을 때만 성공"이어야 한다.
--
--   · current = desired            → 이미 그 상태. **멱등 성공** (재전송·병렬 중복 흡수)
--   · current = expected           → 정상 전이. 적용하고 desired 반환
--   · 그 외                        → 내가 보던 상태가 아니다. **적용하지 않고** actual 반환
--                                    (route 가 409 로 돌려주고 UI 가 그 값으로 reconcile)
--
-- 반환은 jsonb `{"rating": <최종 actual>, "applied": <bool>}`. smallint 단독 반환으로는
-- "적용됨 NULL"과 "충돌이라 안 바꿨는데 마침 NULL"을 구분할 수 없다.
--
-- 호출자(route)는 이미 소유권(이 답변이 이 유저의 야잘알봇 대화 것인지)과 대상 여부
-- (rag/dictionary answer 인지)를 검증한 뒤 호출한다 — 이 함수는 그것을 판단하지 않는다.
DROP FUNCTION IF EXISTS public.set_baseball_genius_answer_feedback(
  uuid, bigint, bigint, text, text, smallint, smallint);

CREATE OR REPLACE FUNCTION public.set_baseball_genius_answer_feedback(
  p_user_id uuid,
  p_answer_message_id bigint,
  p_question_message_id bigint,
  p_question_log_id uuid,
  p_match_path text,
  p_reply_kind text,
  -- **원하는 최종 상태**(set semantics). 1 / -1 / NULL(=표 없음).
  p_desired smallint,
  -- 클릭 직전에 유저가 보고 있던 상태. CAS 의 비교 대상이다.
  p_expected_prev smallint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current smallint;
BEGIN
  IF p_desired IS NOT NULL AND p_desired NOT IN (1, -1) THEN
    RAISE EXCEPTION 'invalid desired rating: %', p_desired;
  END IF;
  IF p_expected_prev IS NOT NULL AND p_expected_prev NOT IN (1, -1) THEN
    RAISE EXCEPTION 'invalid expected_prev: %', p_expected_prev;
  END IF;
  IF p_question_message_id IS NULL OR p_question_log_id IS NULL THEN
    RAISE EXCEPTION 'question binding is required';
  END IF;

  -- ---- same-key 직렬화 ----
  -- 트랜잭션 단위(_xact)라 함수 종료 시 자동 해제되고, 서로 다른 키는 대기하지 않는다.
  -- 단일 bigint 오버로드를 쓴다. 2인자 형태는 (int, int) 라 bigint 메시지 id 를 못 받는다
  -- (fresh DB 에서 42883 로 죽는 것을 실제 DB 검증에서 확인).
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':' || p_answer_message_id::text, 0)
  );

  -- lock 을 잡은 뒤에 읽는다 — 락 밖에서 읽으면 비교값 자체가 stale 이다.
  SELECT rating INTO v_current
    FROM genius_answer_feedback
   WHERE user_id = p_user_id AND answer_message_id = p_answer_message_id;

  -- 이미 원하는 상태다 → 멱등 성공. 재전송·두 탭 동일 클릭이 여기로 수렴한다.
  IF v_current IS NOT DISTINCT FROM p_desired THEN
    RETURN jsonb_build_object('rating', to_jsonb(v_current), 'applied', true);
  END IF;

  -- 내가 보던 상태가 아니다 → 적용하지 않고 실제 상태를 돌려준다.
  IF v_current IS DISTINCT FROM p_expected_prev THEN
    RETURN jsonb_build_object('rating', to_jsonb(v_current), 'applied', false);
  END IF;

  IF p_desired IS NULL THEN
    DELETE FROM genius_answer_feedback
     WHERE user_id = p_user_id AND answer_message_id = p_answer_message_id;
    RETURN jsonb_build_object('rating', to_jsonb(NULL::smallint), 'applied', true);
  END IF;

  INSERT INTO genius_answer_feedback (
    user_id, answer_message_id, question_message_id, question_log_id,
    match_path, reply_kind, rating
  )
  VALUES (
    p_user_id, p_answer_message_id, p_question_message_id, p_question_log_id,
    p_match_path, p_reply_kind, p_desired
  )
  ON CONFLICT (user_id, answer_message_id) DO UPDATE
    SET rating = EXCLUDED.rating,
        updated_at = now();

  RETURN jsonb_build_object('rating', to_jsonb(p_desired), 'applied', true);
END;
$$;

REVOKE ALL ON FUNCTION public.set_baseball_genius_answer_feedback(uuid, bigint, bigint, uuid, text, text, smallint, smallint) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.set_baseball_genius_answer_feedback(uuid, bigint, bigint, uuid, text, text, smallint, smallint) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.set_baseball_genius_answer_feedback(uuid, bigint, bigint, uuid, text, text, smallint, smallint) FROM authenticated;
  END IF;
END $$;

-- service_role 에 EXECUTE 를 **명시적으로** 부여한다 (삼순 NO-GO ①).
-- 위 `REVOKE ALL ... FROM PUBLIC` 은 service_role 이 PUBLIC 을 통해 상속받던 EXECUTE 까지
-- 함께 걷어낸다. 기존 DB 는 함수 생성 전에 부여된 별도 권한이 남아 우연히 동작할 수 있지만,
-- **fresh migrated DB 에서는 route 가 42501 로 죽는다.** 우연한 통과에 기대지 않고 명시한다.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.set_baseball_genius_answer_feedback(uuid, bigint, bigint, uuid, text, text, smallint, smallint) TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.genius_answer_feedback TO service_role;
  END IF;
END $$;
