-- ============================================================
-- 야구 용어/룰 질문 AI MVP — 스키마 (spec: specs/baseball-qa-mvp.md)
-- ------------------------------------------------------------
-- 3단 파이프라인: ①검수 용어사전(토큰 0) → ②동일질문 캐시 → ③flash-lite LLM.
-- 3테이블 모두 RLS ENABLE + 정책 0개 → 클라 직접 접근 전면 차단,
-- 접근은 /api/baseball-qa route(service_role) 전용.
-- ⚠️ 멱등(IF NOT EXISTS). 운영 DB 직접 적용 금지 — 머지 게이트 후 적용.
-- ============================================================

-- ① 검수 용어사전 (시드: 20260730_baseball_qa_seed.sql)
CREATE TABLE IF NOT EXISTS baseball_glossary (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term text NOT NULL UNIQUE,
  aliases text[] NOT NULL DEFAULT '{}',
  answer text NOT NULL,
  category text NOT NULL DEFAULT 'rule',
  source text NOT NULL DEFAULT 'KBO 야구규칙/리그규정 기반 자체 검수',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ② 동일질문 캐시 (LLM 정상 답변만 저장; UNSURE/NOT_BASEBALL 미저장)
CREATE TABLE IF NOT EXISTS baseball_qa_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_norm text NOT NULL UNIQUE,
  answer text NOT NULL,
  hit_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_hit_at timestamptz NOT NULL DEFAULT now()
);

-- ③ 전체 질문 로그 (경로/토큰 추적 → LLM 호출률·비용·오답 측정)
CREATE TABLE IF NOT EXISTS baseball_qa_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  question text NOT NULL,
  question_norm text NOT NULL,
  match_path text NOT NULL CHECK (match_path IN ('dictionary','cache','llm','blocked','unsure','limited','error')),
  answer text,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 일일 한도 카운트용 (user_id + created_at range)
CREATE INDEX IF NOT EXISTS idx_baseball_qa_log_user_day
  ON baseball_qa_log (user_id, created_at DESC);

-- RLS: 전면 차단 (정책 0개 → service_role만 접근)
ALTER TABLE baseball_glossary ENABLE ROW LEVEL SECURITY;
ALTER TABLE baseball_qa_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE baseball_qa_log ENABLE ROW LEVEL SECURITY;
