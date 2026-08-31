-- 야잘알봇 의도 라우팅 — **판정 durable 재생** (삼순 2026-08-31 지시 ①).
--
-- 왜 필요한가 (2026-08-31 실측, `state/yaj-48h/intent-determinism-20260831.json`)
--   분류기에 `temperature: 0` 을 줬는데도 **같은 request body(sha256 동일)에서 판정이 갈린다**:
--     `방금 점수 어떻게 냈어?`  FOLLOWUP 5 : BASEBALL 5   (10회)
--     `안해주면`               BASEBALL 8 : FOLLOWUP 2
--     `질문답헤줘`             BASEBALL 9 : SMALLTALK_SAFE 1
--   (clear case 4건은 10/10 동일 — 전부 갈리는 게 아니라 모호한 입력에서만 갈린다)
--
--   야잘알봇은 durable 재처리 구조다(`/api/baseball-qa` 즉시 경로 + cron drain). 같은
--   messageId 가 두 번 처리될 때 판정이 달라지면 **유저가 받는 답이 바뀐다.** 그래서
--   "그 메시지의 최초 판정" 을 고정한다.
--
-- 🔴 **전역 캐시가 아니다** (삼순 NO-GO). `question_norm` 키로 캐시하면 같은 문장이라도
--   직전 맥락·시점이 다른데 남의 판정을 물려받는다. 키는 반드시 이 메시지의 것이어야 한다:
--     message_id (PK)  +  입력 fingerprint  +  prompt version
--   fingerprint 는 질문 + 주입된 직전 대화까지 포함한 해시라, 맥락이 달라지면 재사용되지
--   않는다. version 은 프롬프트 본문 해시라, 계약을 바꾸면 과거 판정이 자동 무효가 된다.
--
-- 데이터 변경 0. 컬럼 추가만(기존 행은 NULL = 판정 없음 = 종전과 동일 동작).
-- 롤백 = 세 컬럼 DROP.
--
-- ⚠️ 앱이 이 migration 보다 먼저 배포돼도 안전하다 — 서버 구현이 컬럼 부재(42703/PGRST204)를
--   "판정 없음" 으로 접고 그냥 새로 분류한다. 즉 이 migration 은 **재현성을 켜는** 것이지
--   기능을 켜는 것이 아니다.

ALTER TABLE public.genius_question_jobs
  -- 최초 판정의 sentinel (`SMALLTALK_SAFE`·`SMALLTALK_SCOPE`·`FOLLOWUP`·`NEEDS_CLARIFICATION`·`BASEBALL`).
  ADD COLUMN IF NOT EXISTS intent_verdict text,
  -- 판정 당시 입력(질문 + 직전 대화) + 프롬프트 버전의 해시. 불일치면 재사용하지 않는다.
  ADD COLUMN IF NOT EXISTS intent_fingerprint text,
  -- 가드를 통과한 생성 답변(SMALLTALK_SAFE·FOLLOWUP 일 때만). 가드 미통과는 NULL 이다.
  ADD COLUMN IF NOT EXISTS intent_answer text,
  -- 되묻기 대상 폐쇄집합(`game`|`other`). NEEDS_CLARIFICATION 일 때만 채워진다.
  --   재생 시 이 값도 복원해야 같은 messageId 가 같은 문구(경기 목록 포함 여부)를 받는다.
  ADD COLUMN IF NOT EXISTS intent_clarify text,
  -- 질문이 어느 KBO 구단의 것을 묻는가(구단 10개 canonical 또는 NULL).
  --   마스코트·구장 시설처럼 구단명이 문장에 없는 경우까지 LLM 이 귀속을 판정한다 —
  --   코드에 이름 목록을 두면 반례마다 어휘가 자라기 때문이다(하린아빠 2026-08-31).
  ADD COLUMN IF NOT EXISTS intent_team text;

COMMENT ON COLUMN public.genius_question_jobs.intent_verdict IS
  '의도 라우팅 최초 판정 sentinel. 같은 messageId 재처리 시 이 값을 재생해 경로를 고정한다(provider 비결정성 방어).';
COMMENT ON COLUMN public.genius_question_jobs.intent_fingerprint IS
  '판정 입력(question + 직전 대화 + 프롬프트 버전) 해시. 불일치 시 재생하지 않고 다시 분류한다 — 전역 캐시가 되지 않도록 하는 키.';
COMMENT ON COLUMN public.genius_question_jobs.intent_answer IS
  '사실주장 가드를 통과한 생성 답변. 가드 미통과·해당없음은 NULL(코드 고정 문안이 나간다).';
COMMENT ON COLUMN public.genius_question_jobs.intent_clarify IS
  '되묻기 대상(game|other). 코드가 폐쇄집합으로 접어 저장하므로 그 밖의 값은 들어오지 않는다.';
COMMENT ON COLUMN public.genius_question_jobs.intent_team IS
  '질문이 귀속되는 KBO 구단 canonical(LG/KIA/두산/롯데/삼성/한화/키움/KT/SSG/NC) 또는 NULL. 코드가 폐쇄집합으로 접어 저장한다.';
