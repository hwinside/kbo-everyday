-- 생성 RAG 답변의 톤 준수율 관측 (#1186 후속, 2026-08-14 하린아빠 A안).
--
-- `false` 는 실패/차단이 아니다. 답변은 이미 다른 안전 검증(JSON/status/URL/길이/숫자 근거)을
-- 모두 통과해 서빙됐고, LLM 이 합니다체 프롬프트를 지키지 않았다는 관측만 남긴다.
-- `null` 은 **서빙된 생성 RAG 답변이 없거나 판정 불가**다 — 비생성 경로(사전·구조화·고정문)와
-- 안전검증(JSON/status/URL/길이/숫자) 탈락으로 폐기된 RAG 를 포함한다.
--
-- 데이터 변경 0 · nullable · 멱등. 기존 행은 전부 null 유지.
ALTER TABLE public.genius_question_logs
  ADD COLUMN IF NOT EXISTS tone_compliant boolean;

COMMENT ON COLUMN public.genius_question_logs.tone_compliant IS
  'Generated RAG tone observation only: false is served, null means no served generated RAG answer or not assessable';
