-- 되묻기 감사 식별자 — `match_path='needs_clarification'`
--
-- ## 왜 새 라벨인가
--
-- 의도 라우팅(2026-08-31)이 `NEEDS_CLARIFICATION` 경로를 새로 만든다. 조회해야 답할 수
-- 있는데 **무엇을 조회할지 특정이 안 되는** 경우 되묻는 경로다.
--
-- ⚠️ `context_missing` 을 재사용하지 않는 이유는 **유저가 다음에 적어야 할 것이 다르기**
--   때문이다:
--     `context_missing`      = "무엇에 **이어서** 물으셨나요"  (직전 턴이 없다)
--     `needs_clarification`  = "어느 **경기·선수** 말씀인가요" (직전 턴은 있으나 대상이 안 잡힌다)
--   감사 축도 다르다 — "되묻기가 얼마나 나갔고 그중 **과잉 되묻기**(알 수 있는데 물은 것)는
--   몇 건인가" 를 세려면 전용 라벨이 유일한 식별자다.
--   (`scope_guide` 를 `ack` 에서, `stat_clarify` 를 `unsure` 에서 분리한 것과 같은 축.)
--
-- ## 적용 순서 (⚠️ 배포보다 먼저)
--
-- 이 CHECK 확장이 배포보다 늦으면 되묻기 INSERT 가 제약 위반(23514)으로 실패해 job 이
-- 통째로 failed 로 떨어진다 — 2026-08-03 `match_path='rag'` 미허용으로 선수질문이 전량
-- pipeline_failed 났던 사고와 같은 축이다. **migration 을 먼저 적용한다.**
--
-- ## 기준 CHECK
--
-- 현 시점 최신 CHECK 는 `20260823120000`(`product_feature_guide`) 이다. 그 **전체 union**
-- 위에 `needs_clarification` 만 더한다 — 부분 union 으로 재정의하면 그 사이 추가된 라벨이
-- 적용 순서상 **조용히 사라진다**(구 `20260809150000` 이 실제로 그랬고 빌드 게이트가 잡았다).
--
-- 데이터 변경 0 · 멱등. 기존 행의 `match_path` 는 건드리지 않는다.
ALTER TABLE public.genius_question_logs
  DROP CONSTRAINT IF EXISTS genius_question_logs_match_path_check;
ALTER TABLE public.genius_question_logs
  ADD CONSTRAINT genius_question_logs_match_path_check CHECK (
    match_path IN (
      'dictionary','cache','llm','service_redirect','history_hold',
      'blocked','unsure','limited','error','context_missing','ack','rag',
      -- 유저가 교정 후보를 수용해 답한 경로 (#1151, 20260813203000).
      'player_picker','question_correction','kbo_structured',
      'team_rag','news_rag','scope_guide',
      -- 실측된 이름 오타를 받아 생성 없이 그 이름을 되물은 경로 (#1135).
      'name_suggest',
      -- `<X> <지표>` 에서 X 를 운영 데이터로 특정하지 못해 되물은 경로.
      -- 화면 취급은 `unsure` 와 같지만(둘 다 못 답함) 원인 축이 다르다.
      'stat_clarify',
      -- 우리 앱에 실재하는 기능을 물어 그 경로를 안내한 경로 (2026-08-23, #1288 후속).
      -- 화면 취급은 `ack`(답을 준 것)이고, 못 답한 축의 분모에 들어가면 안 된다.
      'product_feature_guide',
      -- 조회 대상이 특정되지 않아 **생성 없이** 되물은 경로 (2026-08-31, 의도 라우팅).
      -- 화면 취급은 `unavailable`(아직 답을 못 받았다)이고, `context_missing` 과는
      -- 유저가 다음에 적어야 할 것이 달라 라벨을 분리한다.
      'needs_clarification'
    )
  );
