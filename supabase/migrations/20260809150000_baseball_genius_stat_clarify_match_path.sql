-- `<X> <지표>` 미결속 되묻기 감사 식별자 — `match_path='stat_clarify'`
--
-- ⚠️ 왜 기존 `unsure` 를 재사용하지 않는가 (삼순 2026-08-08).
--
-- 초안은 migration 을 아끼려고 되묻기를 `unsure` 로 기록했다. 그런데 `unsure` 는 이미
-- **LLM 이 답을 확신하지 못한 경우**에 쓰이고 있다(pipeline.ts 의 UNSURE_SENTINEL 경로).
-- 한 칸에 넣으면 두 가지가 섞인다:
--   ① LLM 까지 갔는데 확신 못 함        — 생성 품질 문제
--   ② 애초에 대상을 특정 못 해 되물음    — 결속 데이터 부재 문제
-- 원인도 처방도 다른데 분모가 하나가 되어 "되묻기가 얼마나 나갔고 그중 과차단은
-- 몇 건인가" 를 셀 수 없다.
--
-- `team_rag`(2026-08-07)·`news_rag`·`scope_guide`(2026-08-08)를 나눈 것과 같은 축이다:
-- 화면 취급이 같아도 **감사 축이 다르면 라벨을 나눈다**.
--
-- ⚠️ 타임스탬프 이력 (2026-08-09, 이 파일이 `20260808200000` 을 대체한다).
--   원래 이 확장은 `20260808200000` 이었는데, 그 사이 main 에 머지·Production 적용된
--   `20260808230000`(#1135, `name_suggest`)이 같은 CHECK 를 DROP+재정의한다. 구 타임스탬프를
--   유지하면 적용 순서상 `stat_clarify` 가 나중 migration 에 덮여 **조용히 사라진다** —
--   Vercel 빌드 게이트(`코드의 MatchPath 가 DB CHECK 에 없다`)가 실제로 잡은 결함이다.
--   그래서 최신 CHECK 정의(#1135) 전체를 기준으로 그 위에 `stat_clarify` 만 더한다.
--
-- ⚠️ 이 CHECK 확장이 배포보다 늦으면 되묻기 INSERT 가 제약 위반(23514)으로 실패해
--   job 이 통째로 failed 로 떨어진다(2026-08-03 `match_path='rag'` 미허용으로 선수질문이
--   전량 pipeline_failed 났던 사고와 같은 축). migration 을 **먼저** 적용한다.
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
      'scope_guide',
      -- 실측된 이름 오타를 받아 생성 없이 그 이름을 되물은 경로 (#1135).
      'name_suggest',
      -- `<X> <지표>` 에서 X 를 운영 데이터로 특정하지 못해 되물은 경로.
      -- 화면 취급은 `unsure` 와 같지만(둘 다 못 답함) 원인 축이 다르다.
      'stat_clarify'
    )
  );
