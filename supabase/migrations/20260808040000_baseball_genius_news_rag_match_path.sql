-- 최신 기사 근거 감사 식별자 — `match_path='news_rag'`
--
-- ⚠️ 왜 `team_rag` 와 분리하는가.
--
-- `team_rag` 를 `rag` 에서 분리했던 이유(2026-08-07)와 같은 축이지만, 기사는 한 가지가 더 있다:
-- **근거의 수명이 다르다.** 나무위키 구단 문서는 수집 시점에 고정돼 계속 남지만, 기사는
-- `purge_baseball_genius_news_articles()` 가 30일이 지나면 물리 삭제한다.
--
-- 그래서 같은 질문이 지난달과 오늘 다른 답을 낼 수 있다. 오답 감사를 할 때 문서 경로와
-- 섞이면 "근거가 사라진 것"과 "근거가 틀린 것"을 구분할 수 없다 — 전자는 정상 동작이고
-- 후자는 결함인데, 라벨이 같으면 둘 다 `team_rag` 한 칸에 들어가 판정이 불가능해진다.
--
-- ⚠️ 이 CHECK 확장이 배포보다 늦으면 기사 답변 INSERT 가 제약 위반으로 실패해 job 이
--   failed 로 떨어진다(2026-08-03 `match_path='rag'` 미허용으로 선수질문 전량
--   pipeline_failed 가 났던 것과 같은 사고). migration 을 **먼저** 적용한다.
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
      -- 최근 30일 구단 기사 근거. 근거 수명이 30일이라 문서 경로와 감사 축을 분리한다.
      'news_rag'
    )
  );
