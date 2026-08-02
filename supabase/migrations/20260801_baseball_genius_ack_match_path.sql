-- 야잘알봇: 단독 감사·확인 인사 결정론 응답 경로(ack)를 로그 allowlist에 추가한다.
-- `고마워`/`감사합니다` 같은 직전 답변에 대한 대화 행위는 야구 질문이 아니지만 차단 대상도
-- 아니다. LLM/캐시를 쓰지 않고 짧게 응답하며, 어드민 모니터(#983)에서 blocked와 구분되도록
-- 별도 match_path 라벨로 기록한다. 이 CHECK 확장이 없으면 ack 로그 INSERT가 제약 위반으로
-- 실패해 job이 failed로 떨어진다.
ALTER TABLE public.genius_question_logs
  DROP CONSTRAINT IF EXISTS genius_question_logs_match_path_check;
ALTER TABLE public.genius_question_logs
  ADD CONSTRAINT genius_question_logs_match_path_check CHECK (
    match_path IN (
      'dictionary','cache','llm','service_redirect','history_hold',
      'blocked','unsure','limited','error','context_missing','ack'
    )
  );
