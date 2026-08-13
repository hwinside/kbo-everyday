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

-- 관측 상태 (삼순 1차 ④): question_normalized null 만으로는 미호출·거절·오류를 구분할 수 없어
-- 발동률·오교정 감사의 분모를 못 만든다. 정규화가 호출된 모든 행에 기록된다(미발동 = null).
alter table genius_question_logs
  add column if not exists question_normalize_status text;

alter table genius_question_logs
  drop constraint if exists genius_question_logs_normalize_status_check;
alter table genius_question_logs
  add constraint genius_question_logs_normalize_status_check
  check (
    question_normalize_status is null
    or question_normalize_status in ('accepted_surface', 'rejected', 'no_change', 'error')
  );

comment on column genius_question_logs.question_normalize_status is
  '질문 1차 LLM 정규화 관측 상태. null=미발동, accepted_surface=공백/부호만 교정 수용, rejected=가드 탈락 또는 Tier B 오탈자 HOLD(원문 진행), no_change=교정 없음, error=호출 장애(원문 진행).';
