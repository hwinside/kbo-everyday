-- 질문 1차 LLM 정규화 관측 컬럼 (2026-08-11 하린아빠 착수 지시)
--
-- LLM 정규화가 **수용된** 질문에서만 채워진다. question(원문)과 나란히 남아
-- "정규화가 얼마나 발동했고 오교정이 몇 건인가" 감사의 분모가 된다 —
-- 원문을 덮어쓰면 그 감사는 불가능하다.
--
-- additive nullable 컬럼만 추가한다. match_path CHECK·기존 행·기존 쿼리 무변경.
alter table genius_question_logs
  add column if not exists question_normalized text;

comment on column genius_question_logs.question_normalized is
  'LLM 표기 정규화가 수용된 경우의 교정문. null = 정규화 미발동 또는 미수용(원문 진행). question 컬럼은 항상 유저 원문이다.';
