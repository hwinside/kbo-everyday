-- 야잘알봇 v2 S2b: 선수 서술형 질문을 수집된 tier2 문서 근거로 답한 경로(rag)를
-- 로그 allowlist에 추가한다.
--
-- 왜 별도 라벨인가: `llm`으로 뭉뚱그리면 어드민 모니터(#983)에서 "근거 없이 모델이 생성한 답"과
-- "수집 문서에 근거한 답"을 구분할 수 없다. 두 경로는 프롬프트·검증 가드·리스크가 전혀 다르므로
-- (rag 경로는 숫자 출력 자체를 차단하고 출처 표기를 강제한다) 관측 단위를 분리한다.
-- 이 CHECK 확장이 없으면 rag 로그 INSERT가 제약 위반으로 실패해 job이 failed로 떨어진다.
--
-- genius_question_jobs.source는 CHECK 없는 text 컬럼이라 별도 변경이 필요 없다.
ALTER TABLE public.genius_question_logs
  DROP CONSTRAINT IF EXISTS genius_question_logs_match_path_check;
ALTER TABLE public.genius_question_logs
  ADD CONSTRAINT genius_question_logs_match_path_check CHECK (
    match_path IN (
      'dictionary','cache','llm','service_redirect','history_hold',
      'blocked','unsure','limited','error','context_missing','ack','rag'
    )
  );
