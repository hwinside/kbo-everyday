-- 구단 tier2 감사 식별자 — `match_path='team_rag'`
--
-- ⚠️ 왜 필요한가 (삼순 2026-08-07).
--
-- 선수 서술형(S2b)·공식 문서(tier1)·구단 서술형 RAG 가 **전부** `match_path='rag'` 로
-- 기록돼 왔다. 그래서 "구단 답변만" 뽑아낼 방법이 없었다. 출시 후 7일 전수 감사
-- (숫자 누수·과차단 실측)를 하겠다고 약속해 놓고 정작 실행 가능한 쿼리를 못 짰다.
--
-- 2026-08-07 에 한글 수사 파서(224줄+사전 190항목)를 삭제하면서 이 식별자의 무게가
-- 달라졌다. 코드 결정론 가드가 유니코드 숫자 하나만 남았으므로, 한글 수치의 실제
-- 위반율은 **감사로만** 알 수 있다. 감사가 유일한 안전망인데 대상을 못 고르면
-- 안전망이 없는 것과 같다.
--
-- 데이터 변경 0 · 멱등. 기존 행의 `match_path` 는 건드리지 않는다(과거 구단 답변은
-- 여전히 `rag` 로 남는다 — 소급 재분류는 근거가 없어 하지 않는다).
ALTER TABLE public.genius_question_logs
  DROP CONSTRAINT IF EXISTS genius_question_logs_match_path_check;
ALTER TABLE public.genius_question_logs
  ADD CONSTRAINT genius_question_logs_match_path_check CHECK (
    match_path IN (
      'dictionary','cache','llm','service_redirect','history_hold',
      'blocked','unsure','limited','error','context_missing','ack','rag',
      'player_picker','kbo_structured',
      -- 구단 서술형 RAG. `rag`(선수·공식)와 분리해야 구단 전수 감사가 가능하다.
      'team_rag'
    )
  );

-- ⚠️ 이 CHECK 확장이 배포보다 늦으면 구단 답변 INSERT 가 제약 위반으로 실패해
--   job 이 failed 로 떨어진다(2026-08-03 `match_path='rag'` 미허용으로 선수질문
--   전량 pipeline_failed 가 났던 것과 같은 사고). migration 을 **먼저** 적용한다.
