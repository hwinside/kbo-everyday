-- 생성 RAG 관측 4칸 (2026-08-16 하린아빠 "0부터 착수" + 삼순 NO-GO 1~4차 반영).
--
-- 왜 필요한가:
--   tier2(구단·선수·뉴스) 경로는 답변에 유니코드 숫자가 하나라도 있으면 답 전체를 폐기한다
--   (`numeric_claim_ungrounded`). 그런데 폐기된 건 로그에 `match_path='unsure'`(구단 수치질문은
--   `history_hold`)로만 남아 **JSON 깨짐·길이초과·숫자가드가 구분되지 않고**, 게다가
--   **어느 RAG 경로에서 버렸는지도 사라진다**. 즉 "숫자 정책 때문에 경로별로 얼마나 폐기되는가"를
--   지금은 수치로 답할 수 없다. 정책을 열기 전에 분모부터 만든다.
--
--   ⚠️ 이 컬럼들이 만드는 것은 **폐기율**이다. "정확한 답을 얼마나 버렸는가"(정답 손실률)는
--      이 칸들로 알 수 없다 — 폐기된 답이 옳았는지는 어디서도 판정하지 않는다.
--      정답 손실률은 **경로별 표본 감사로만** 확정한다.
--
-- 계약:
--   · rag_attempt_path       = 생성 RAG 를 **시도한 경로**. 성공·폐기 **모두** 채운다
--                              (폐기에만 채우면 분자만 있고 분모가 없어 비율을 못 낸다).
--                              null = 생성 RAG 미시도(사전·구조화·고정문·generic LLM).
--   · rag_discard_reason     = 폐기 사유. null = 폐기 없음.
--   · rag_question_numeric_count = **질문**의 숫자 토큰 개수. 성공·폐기 모두 채운다.
--
--     ⚠️ **개수 두 칸이 확정하는 것은 "질문 기원 여부" 하나뿐이다** (삼순 3차 ②·4차).
--        개수에는 값 동일성이 없다:
--          · `질문=0 · 답변>0` → 답변의 숫자는 **질문에 없던 숫자**다 (확정).
--                                 🔴 여기까지다. **근거 문서에서 복사했을 수도 있으므로**
--                                    `모델 창작`·`지어냄`·`근거에 없음` 은 확정되지 않는다.
--                                    출처·정확성 **미판정**.
--          · `질문>0 · 답변>0` → **미확정.** 질문 숫자를 되받았는지 다른 숫자인지는
--                                 값을 비교해야 아는데, 값은 **일부러 저장하지 않는다**
--                                 (익명집계 조건). 이 칸으로 결론을 내지 않는다.
--          · `질문>0 · 답변=0` → 숫자 폐기와 무관한 행.
--        `창작/지어냄/근거에 없음` 분류는 전부 **표본 감사 영역**이다.
--   · rag_discard_numeric_count = 폐기된 **답변**의 숫자 토큰 개수만. 값도 원문도 저장하지 않는다.
--                              ⚠️ 개수 하나로 답변 성격을 단정하지 않는다 — `1` 이라도 연도일 수도,
--                              순위·점수일 수도, 질문 숫자를 되받은 것일 수도 있다. "구제 가능한
--                              정답이었는가" 분류는 **표본 감사**로만 확정한다(삼순 2026-08-16 ③).
--   · **관측값이다.** 이 칸들을 읽고 분기하는 서빙 로직을 만들지 않는다.
--
-- CHECK 허용집합은 코드의 `RAG_DISCARD_REASONS`·`RAG_ATTEMPT_PATHS` 폐쇄집합과 1:1이다.
-- 게이트(`qa:genius-discard-reason`)가 이 파일 문면과 코드 상수를 대조해 어긋나면 RED 를 낸다 —
-- 한쪽만 늘리면 배포 후 23514 로 터지므로 상수·CHECK·게이트를 같은 PR 에서 움직인다.
--
-- additive nullable 컬럼만 추가한다. match_path CHECK·기존 행·기존 쿼리 무변경. 멱등.
alter table genius_question_logs
  add column if not exists rag_discard_reason text;

alter table genius_question_logs
  add column if not exists rag_attempt_path text;

alter table genius_question_logs
  add column if not exists rag_question_numeric_count integer;

alter table genius_question_logs
  add column if not exists rag_discard_numeric_count integer;

alter table genius_question_logs
  drop constraint if exists genius_question_logs_rag_discard_reason_check;
alter table genius_question_logs
  add constraint genius_question_logs_rag_discard_reason_check
  check (
    rag_discard_reason is null
    or rag_discard_reason in (
      'malformed_json',
      'model_insufficient',
      'missing_answer',
      'empty_answer',
      'too_long',
      'unsafe_output',
      'unknown_status',
      'numeric_claim_ungrounded',
      'numeric_not_in_evidence',
      'numeric_not_in_question'
    )
  );

alter table genius_question_logs
  drop constraint if exists genius_question_logs_rag_attempt_path_check;
alter table genius_question_logs
  add constraint genius_question_logs_rag_attempt_path_check
  check (
    rag_attempt_path is null
    or rag_attempt_path in ('player', 'official', 'team', 'news')
  );

-- 개수는 음수가 될 수 없다. 상한은 두지 않는다(길이 상한이 이미 답변을 제한한다).
alter table genius_question_logs
  drop constraint if exists genius_question_logs_rag_discard_numeric_count_check;
alter table genius_question_logs
  add constraint genius_question_logs_rag_discard_numeric_count_check
  check (rag_discard_numeric_count is null or rag_discard_numeric_count >= 0);

alter table genius_question_logs
  drop constraint if exists genius_question_logs_rag_question_numeric_count_check;
alter table genius_question_logs
  add constraint genius_question_logs_rag_question_numeric_count_check
  check (rag_question_numeric_count is null or rag_question_numeric_count >= 0);

comment on column genius_question_logs.rag_discard_reason is
  'Generated RAG discard reason (observation only). null = nothing discarded. numeric_claim_ungrounded = the answer contained a number so the tier2 policy dropped it WITHOUT comparing against evidence; whether the number was grounded, and whether the rest of the answer was correct, are BOTH unassessed. Discard rate is not answer-loss rate.';

comment on column genius_question_logs.rag_attempt_path is
  'Which generated RAG path was attempted (player|official|team|news). Filled on BOTH served and discarded rows so per-path discard rate has a denominator. null = no generated RAG attempt.';

comment on column genius_question_logs.rag_discard_numeric_count is
  'Numeric token COUNT of the discarded answer (anonymised: no values, no text). null = nothing discarded or not assessable. A count alone does NOT classify the answer (a 1 may be a year, a rank, a score, or a number echoed from the question); use sample audit.';

comment on column genius_question_logs.rag_question_numeric_count is
  'Numeric token COUNT of the question (anonymised). Filled on BOTH served and discarded rows. Counts carry NO value identity. question=0 & answer>0 establishes only that the answer numbers did NOT originate in the question - they may still have been copied from evidence, so origin and accuracy stay UNASSESSED (do not read it as invention). question>0 & answer>0 is UNDECIDED: reuse vs different numbers needs value comparison, which we deliberately do not store. Any invention/groundedness classification is sample-audit territory.';
