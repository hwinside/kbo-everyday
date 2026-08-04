-- 야잘알봇 로그 match_path allowlist 합집합 hotfix (2026-08-04).
--
-- 배경: `genius_question_logs.match_path` CHECK 는 기능이 늘 때마다 라벨이 추가돼 왔는데
-- (`ack` = 감사·확인 인사 결정론 응답, `rag` = 수집 문서 근거 답변), 두 확장이 각각
-- `20260801_baseball_genius_ack_match_path.sql` / `20260801_baseball_genius_rag_match_path.sql`
-- 로 나뉘어 있었고 둘 다 **날짜만 있는 version 접두사**(`20260801`)를 써서 같은 날 다른
-- 마이그레이션들과 version 이 충돌한다. 그 결과 ledger 에 정상 등록되지 못했고, 운영 DB 에는
-- `rag` 가 빠진 채로 남아 선수 질문 로그 INSERT 가 23514 로 실패 → job 이 failed 로 떨어졌다.
--
-- 이 파일이 하는 일: 위 두 라벨을 **합집합 한 벌**로 다시 선언한다. 개별 확장 파일을 raw 로
-- 재적용하지 않는다(재적용은 서로가 서로의 라벨을 지우는 순서 의존이 있다). 여기서부터는
-- 이 파일이 match_path allowlist 의 SSOT 다. 라벨을 추가할 땐 이 목록을 늘린 새 마이그레이션을
-- **고유 timestamp version** 으로 추가한다.
--
-- 라벨 정의(어드민 모니터 #983 관측 단위):
--   dictionary       사전 히트          cache           동일 질문 캐시 히트
--   llm              모델 생성 답변      rag             수집 문서 근거 답변(출처 표기 강제)
--   service_redirect 서비스 안내로 전환   history_hold    과거 기록 질문 보류
--   blocked          범위 밖 차단        unsure          확신 부족 응답
--   limited          쿼터 제한          error           파이프라인 오류
--   context_missing  맥락 없음          ack             감사·확인 인사 결정론 응답
--
-- 멱등: DROP IF EXISTS + ADD 로 항상 같은 최종 상태에 수렴한다. 기존 행은 건드리지 않는다
-- (합집합이므로 기존 값은 전부 계속 허용된다 → 기존 행 재검증에서 걸릴 수 없다).
ALTER TABLE public.genius_question_logs
  DROP CONSTRAINT IF EXISTS genius_question_logs_match_path_check;

ALTER TABLE public.genius_question_logs
  ADD CONSTRAINT genius_question_logs_match_path_check CHECK (
    match_path IN (
      'dictionary',
      'cache',
      'llm',
      'service_redirect',
      'history_hold',
      'blocked',
      'unsure',
      'limited',
      'error',
      'context_missing',
      'ack',
      'rag'
    )
  );
