-- 생성 RAG 관측 3칸 (2026-08-16 하린아빠 "0부터 착수" + 삼순 1차 NO-GO ①·익명집계 조건).
--
-- 왜 필요한가:
--   tier2(구단·선수·뉴스) 경로는 답변에 유니코드 숫자가 하나라도 있으면 답 전체를 폐기한다
--   (`numeric_claim_ungrounded`). 그런데 폐기된 건 로그에 `match_path='unsure'`(구단 수치질문은
--   `history_hold`)로만 남아 **JSON 깨짐·길이초과·숫자가드가 구분되지 않고**, 게다가
--   **어느 RAG 경로에서 버렸는지도 사라진다**. 즉 "숫자 금지 때문에 정확한 답이 얼마나 함께
--   버려지는가"도, "뉴스 손실이 얼마인가"도 지금은 수치로 답할 수 없다.
--   정책을 열기 전에 분모부터 만든다.
--
-- 계약:
--   · rag_attempt_path       = 생성 RAG 를 **시도한 경로**. 성공·폐기 **모두** 채운다
--                              (폐기에만 채우면 분자만 있고 분모가 없어 비율을 못 낸다).
--                              null = 생성 RAG 미시도(사전·구조화·고정문·generic LLM).
--   · rag_discard_reason     = 폐기 사유. null = 폐기 없음.
--   · rag_discard_numeric_count = 폐기된 답변의 숫자 토큰 **개수**만. 값도 원문도 저장하지 않는다
--                              (삼순 익명집계 조건). `1` 이면 서술형에 연도 하나 섞인 것이고,
--                              큰 값이면 수치 나열이라 성격이 다르다 — 이 분포가 B/A 우선순위를 가른다.
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

comment on column genius_question_logs.rag_discard_reason is
  'Generated RAG discard reason (observation only). null = nothing discarded. numeric_claim_ungrounded = tier2 numeric hold discarded an otherwise valid answer.';

comment on column genius_question_logs.rag_attempt_path is
  'Which generated RAG path was attempted (player|official|team|news). Filled on BOTH served and discarded rows so per-path discard rate has a denominator. null = no generated RAG attempt.';

comment on column genius_question_logs.rag_discard_numeric_count is
  'Numeric token COUNT of the discarded answer (anonymised: no values, no text). null = nothing discarded or not assessable.';
