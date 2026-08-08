-- 이름 교정 제안 감사 식별자 — `match_path='name_suggest'`
--
-- ── 왜 필요한가 (2026-08-08 하린아빠 제보, Production 실측) ───────────────────
--
--   유저: `임창규 어떤 선수야`
--   봇  : "임창규는 LG 트윈스의 주축 선수로…"
--
-- 로스터 881명에 `임창규` 는 **없다**(`임찬규` kboId 61101, LG 만 있다). 결속된 근거가
-- 하나도 없는 상태에서 generic LLM 이 받아 **존재하지 않는 사람을 실존으로 만들고**
-- 소속과 위상까지 붙였다. 수치 환각보다 나쁜 종류다 — 유저는 틀렸다는 걸 알 방법이 없다.
--
-- ── 왜 기존 라벨에 접지 않는가 ───────────────────────────────────────────────
--
-- 세 문구가 유저에게 말하는 사실이 서로 다르다:
--   `blocked`      = "그건 우리 주제가 아니다"     → 야구 질문을 한 유저에게 거짓말
--   `unsure`       = "못 알아들었다"               → 우리는 누구인지 아는데 숨기는 것
--   `name_suggest` = "혹시 임찬규 선수를?"          → 유저가 바로 다음 행동을 할 수 있다
--
-- 감사 축도 다르다. "오타 교정이 얼마나 나갔고 그중 오제안(엉뚱한 이름을 들이민 것)은
-- 몇 건인가" 를 세려면 전용 라벨이 유일한 식별자다. `question` 문자열로 구분한다는 발상은
-- 이미 `scope_guide` 에서 틀린 것으로 판명됐다 — 판정이 폐쇄집합이 아니라 구조 판정이라
-- 질문 문자열을 열거할 수 없다.
-- (`team_rag`·`news_rag` 를 `rag` 에서, `scope_guide` 를 `ack` 에서 분리한 것과 같은 축.)
--
-- ⚠️ 이 CHECK 확장이 배포보다 늦으면 교정 제안 INSERT 가 제약 위반(23514)으로 실패해
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
      'scope_guide',
      -- 로스터에 없는 실명을 받아 생성 없이 이름을 되물은 경로.
      'name_suggest'
    )
  );
