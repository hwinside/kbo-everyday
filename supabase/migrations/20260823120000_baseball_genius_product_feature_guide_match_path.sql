-- 제품 기능 안내 감사 식별자 — `match_path='product_feature_guide'`
--
-- ## 왜 새 라벨인가
--
-- #1288 배포 후 종단 QA 실측: `직관기록` 은 되묻기(`stat_clarify`)는 멈췄지만 실 provider 가
-- 3/3 으로 **범위 밖(BLOCKED)** 판정해 "제가 확인할 수 있는 범위는 …" 를 내보냈다.
-- 그런데 `직관 기록` 은 **우리 앱의 기능**(마이페이지 > 직관 기록)이다 — 유저는 우리가
-- 가진 것을 물었는데 "범위 밖" 이라고 답한 셈이다(하린아빠 2026-08-23 확정: 기능 안내로 연결).
--
-- ⚠️ 기존 라벨을 재사용하지 않는 이유는 **감사 축이 다르기 때문**이다:
--   `blocked`          = "그건 우리 주제가 아니다"        → 우리 기능인데 거짓말이 된다
--   `service_redirect` = "운영팀에 문의하세요"            → 한 단계 멀어진다(우린 답을 안다)
--   `product_feature_guide` = "그 기능은 여기 있습니다"   → 유저가 바로 다음 행동을 한다
-- 세 문구가 유저에게 말하는 사실이 다르고, "우리 기능을 물었는데 못 찾아준 건이 몇 건인가"
-- 를 세려면 전용 라벨이 유일한 식별자다.
-- (`scope_guide` 를 `ack` 에서, `stat_clarify` 를 `unsure` 에서 분리한 것과 같은 축.)
--
-- ## 적용 순서 (⚠️ 배포보다 먼저)
--
-- 이 CHECK 확장이 배포보다 늦으면 안내 INSERT 가 제약 위반(23514)으로 실패해 job 이 통째로
-- failed 로 떨어진다 — 2026-08-03 `match_path='rag'` 미허용으로 선수질문이 전량
-- pipeline_failed 났던 사고와 같은 축이다. **migration 을 먼저 적용한다.**
--
-- ## 기준 CHECK
--
-- 현 시점 최신 CHECK 는 `20260814215000`(`stat_clarify`) 이다. 그 전체 union 위에
-- `product_feature_guide` 만 더한다 — 부분 union 으로 재정의하면 그 사이 추가된 라벨이
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
      'product_feature_guide'
    )
  );
