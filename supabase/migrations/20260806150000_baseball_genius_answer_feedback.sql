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
  -- 응답 종류 스냅샷. 현재 적재 대상은 `answer` + `match_path='rag'` 뿐이지만
  -- (하린아빠 2026-08-06 16:36: RAG 답변에 한해서), 나중에 대상을 넓힐 때
  -- **그때 그 표가 어떤 응답에 붙은 것인지** 구분할 수 있어야 하므로 같이 저장한다.
  -- 이 값이 없으면 대상 확대 이후 과거 표와 신규 표를 분리할 근거가 사라진다.
  reply_kind text,
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
  p_reply_kind text,
  p_rating smallint,
  -- 클라가 이번 클릭 **직전에 보고 있던** 상태. 재전송/두 탭 멱등성의 근거다.
  -- NULL 이면 "상태를 모름" → 토글하지 않고 p_rating 으로 확정(set)한다.
  p_expected_prev smallint DEFAULT NULL
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

  -- ---- same-key 직렬화 (삼순 NO-GO ④) ----
  -- 이전 구현은 DELETE → (판정) → INSERT 사이에 경합 창이 있었다. 두 탭이 같은 키로
  -- 동시에 들어오면 둘 다 DELETE 0건 → 둘 다 INSERT 로 가고, ON CONFLICT 가 한 쪽을
  -- UPDATE 로 흥수해 **취소가 적용되지 않은 채 투표로 끝나는** 비결정적 결과가 나온다.
  -- 동일 (user_id, answer_message_id) 트랜잭션을 advisory lock 으로 직렬화한다.
  -- 트랜잭션 단위(_xact)라 함수 종료 시 자동 해제되고, 서로 다른 키는 대기하지 않는다.
  -- 단일 bigint 오버로드를 쓴다. 2인자 형태는 (int, int) 라 bigint 메시지 id 를 못 받는다
  -- (fresh DB 에서 42883 로 죽는 것을 실제 DB 검증에서 확인).
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':' || p_answer_message_id::text, 0)
  );

  -- ---- 멱등한 취소 판정 (삼순 2차 blocker ②) ----
  -- 이전 구현은 "현재 저장값 == 클릭값이면 삭제"였다. 그래서 **같은 요청이 두 번 도달하면**
  -- (네트워크 재전송, 두 탭이 같은 👍, 클라 retry) 첫 번째가 저장 → 두 번째가 그걸 보고
  -- 취소로 뒤집었다. 사용자는 한 번 눌렀는데 표가 사라진다.
  --
  -- 취소는 **유저가 이미 그 값을 보고 있는 상태에서 다시 눌렀을 때**만 성립한다.
  -- 그 사실은 서버가 알 수 없고 클라만 안다 → `p_expected_prev` 로 받는다.
  --   · p_expected_prev = p_rating  → 유저가 보고 있던 값을 재클릭 = 취소
  --   · 그 외(NULL 포함)            → 확정(set). 재전송이면 같은 값으로 수렴한다(멱등).
  IF p_expected_prev IS NOT NULL AND p_expected_prev = p_rating THEN
    DELETE FROM genius_answer_feedback
     WHERE user_id = p_user_id
       AND answer_message_id = p_answer_message_id
       AND rating = p_rating
    RETURNING rating INTO v_existing;
    -- 이미 지워져 있어도(먼저 도착한 동일 취소 요청) 최종 상태는 같다 → NULL.
    RETURN NULL;
  END IF;

  -- 신규 또는 변경. unique 제약이 사용자당 1표를 보장하므로 ON CONFLICT 로 흡수한다.
  INSERT INTO genius_answer_feedback (
    user_id, answer_message_id, question_message_id, match_path, reply_kind, rating
  )
  VALUES (
    p_user_id, p_answer_message_id, p_question_message_id, p_match_path, p_reply_kind, p_rating
  )
  ON CONFLICT (user_id, answer_message_id) DO UPDATE
    SET rating = EXCLUDED.rating,
        -- 결속 메타는 처음 값이 정본이다. 재투표가 NULL 로 덮어쓰지 않게 COALESCE.
        question_message_id = COALESCE(genius_answer_feedback.question_message_id, EXCLUDED.question_message_id),
        match_path = COALESCE(genius_answer_feedback.match_path, EXCLUDED.match_path),
        reply_kind = COALESCE(genius_answer_feedback.reply_kind, EXCLUDED.reply_kind),
        updated_at = now();

  RETURN p_rating;
END;
$$;

REVOKE ALL ON FUNCTION public.set_baseball_genius_answer_feedback(uuid, bigint, bigint, text, text, smallint, smallint) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.set_baseball_genius_answer_feedback(uuid, bigint, bigint, text, text, smallint, smallint) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.set_baseball_genius_answer_feedback(uuid, bigint, bigint, text, text, smallint, smallint) FROM authenticated;
  END IF;
END $$;

-- service_role 에 EXECUTE 를 **명시적으로** 부여한다 (삼순 NO-GO ①).
-- 위 `REVOKE ALL ... FROM PUBLIC` 은 service_role 이 PUBLIC 을 통해 상속받던 EXECUTE 까지
-- 함께 걷어낸다. 기존 DB 는 함수 생성 전에 부여된 별도 권한이 남아 우연히 동작할 수 있지만,
-- **fresh migrated DB 에서는 route 가 42501 로 죽는다.** 우연한 통과에 기대지 않고 명시한다.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.set_baseball_genius_answer_feedback(uuid, bigint, bigint, text, text, smallint, smallint) TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.genius_answer_feedback TO service_role;
  END IF;
END $$;
