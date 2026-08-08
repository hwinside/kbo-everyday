-- 범위 되묻기 감사 식별자 — `match_path='scope_guide'`
--
-- ⚠️ 왜 `ack` 에 접지 않는가 (삼순 2026-08-08 조건 ④).
--
-- 처음 구현은 migration 을 아끼려고 범위 안내를 `ack`(감사 인사)로 기록했다. 그런데 그러면
-- **이 PR 이 고친 것을 사후에 측정할 수가 없다.** 감사 질문은 "범위 안내가 얼마나 나갔고,
-- 그중 진짜 질문을 덮은 과차단이 몇 건인가" 인데, 감사 인사와 한 칸에 들어가면 분모조차
-- 만들 수 없다.
--
-- 당시 주석은 "필요하면 `question` 문자열로 구분된다(폐쇄집합이라 열거된다)"고 적었지만
-- 그 전제가 틀렸다 — 판정은 폐쇄집합이 아니라 **구조 판정**(`isScopeAskPhrase`)이라
-- 질문 문자열을 열거할 수 없다. 라벨이 유일한 식별자다.
--
-- `team_rag`(2026-08-07)·`news_rag`(2026-08-08)를 `rag` 에서 분리한 것과 같은 축이다:
-- 화면 취급이 같아도 **감사 축이 다르면 라벨을 나눈다**.
--
-- ⚠️ 이 CHECK 확장이 배포보다 늦으면 범위 안내 INSERT 가 제약 위반(23514)으로 실패해
--   job 이 failed 로 떨어진다(2026-08-03 `match_path='rag'` 미허용으로 선수질문이 전량
--   pipeline_failed 났던 사고와 같은 축). migration 을 **먼저** 적용한다.
--
-- 데이터 변경 0 · 멱등. 기존 행의 `match_path` 는 건드리지 않는다.
ALTER TABLE public.genius_question_logs
  DROP CONSTRAINT IF EXISTS genius_question_logs_match_path_check;
ALTER TABLE public.genius_question_logs
  ADD CONSTRAINT genius_question_logs_match_path_check CHECK (
    match_path IN (
      'dictionary','cache','llm','service_redirect','history_hold',
      'blocked','unsure','limited','error','context_missing','ack','rag',
      'player_picker','kbo_structured',
      'team_rag',
      'news_rag',
      -- 범위 되묻기에 범위 안내로 답한 경로. 화면 취급은 `ack` 과 같지만 감사 축이 다르다.
      'scope_guide'
    )
  );
