-- 생성 RAG 답변 폐기 사유 관측 컬럼 (2026-08-16 하린아빠 지시 "0부터 착수").
--
-- 왜 필요한가:
--   tier2(구단·선수·뉴스) 경로는 답변에 유니코드 숫자가 하나라도 있으면 답 전체를 폐기한다
--   (`numeric_claim_ungrounded`). 그런데 폐기된 건 로그에 `match_path='unsure'`(뉴스는
--   `unsure`, 구단 수치질문은 `history_hold`)로만 남아 **JSON 깨짐·길이초과·숫자가드가
--   구분되지 않는다**. 즉 "숫자 금지 때문에 정확한 답이 얼마나 함께 버려지는가"를
--   지금은 수치로 답할 수 없다. 정책을 열기 전에 분모부터 만든다.
--
-- 계약:
--   · null  = 폐기 없음 (서빙된 답변 / 생성 RAG 미경유 / LLM 경계 앞 종결)
--   · not null = 그 사유로 생성 RAG 답변이 폐기됨 (유저는 안내문을 받았다)
--   · **관측값이다.** 이 칸을 읽고 분기하는 서빙 로직을 만들지 않는다.
--
-- CHECK 허용집합은 코드의 `RagDiscardReason` 폐쇄집합과 1:1이다. 게이트
-- (`qa:genius-discard-reason`)가 이 파일 문면과 코드 상수를 대조해 어긋나면 RED 를 낸다 —
-- 한쪽만 늘리면 배포 후 23514 로 터지므로 타입·CHECK·게이트를 같은 PR 에서 움직인다.
--
-- additive nullable 컬럼만 추가한다. match_path CHECK·기존 행·기존 쿼리 무변경. 멱등.
alter table genius_question_logs
  add column if not exists rag_discard_reason text;

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

comment on column genius_question_logs.rag_discard_reason is
  'Generated RAG discard reason (observation only). null = nothing discarded. numeric_claim_ungrounded = tier2 numeric hold discarded an otherwise valid answer.';
