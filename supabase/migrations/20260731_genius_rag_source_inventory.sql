-- 야잘알봇 v2 Hybrid RAG — S2a 소스 인벤토리 + chunk 스토어 (스캐폴드)
-- spec: Notion "v2 Hybrid RAG" rev0.7 §12 / specs/baseball-genius-v2-hybrid-rag.md
-- ⚠️ 운영 DB 직접 적용 금지 — 삼순 GO + 하린아빠 머지 승인 후 별도 적용.
--
-- 계약 요약(§12, 제0원칙):
--   - source_grade tier1 = KBO 공식(기록실). 정량 claim의 유일한 정본.
--   - source_grade tier2 = 나무위키. 서술형 참조 전용. 수치는 tier1 교차검증 전 확정 claim 금지.
--   - 모든 chunk는 source(canonical_url) + revision/as_of 메타를 필수로 갖는다.
--   - inventory는 조용한 누락을 금지한다. 100% 분류 전에는 '전수 완료'라고 표현하지 않는다.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- 1) 소스 인벤토리 — 어떤 엔티티의 어떤 페이지를 수집 대상으로 삼는지의 SSOT
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.genius_source_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 엔티티 축: league(KBO 개요) | team(10구단) | player(로스터 878명) | record_book(KBO 기록실 범주)
  entity_type text NOT NULL CHECK (entity_type IN ('league', 'team', 'player', 'record_book')),
  -- league='KBO', team=teamId 문자열('1'~'10'), player=kboId, record_book=범주 키
  entity_id text NOT NULL,
  entity_name text NOT NULL,

  -- 소스 축: kbo_official(tier1 정본) | namuwiki(tier2 서술 참조)
  source_kind text NOT NULL CHECK (source_kind IN ('kbo_official', 'namuwiki')),
  -- §12 신뢰등급. tier1만 정량 typed claim 생성 자격을 갖는다.
  source_grade text NOT NULL CHECK (source_grade IN ('tier1', 'tier2')),
  canonical_url text,

  -- §12 분류 계약: 전수 inventory는 아래 5값 중 하나로 100% 분류된다.
  --   resolved  = canonical page 확정
  --   missing   = 대상 페이지 없음(확인 완료)
  --   ambiguous = 후보 복수/동명이인 등으로 단일 확정 불가 → 임의 선택 금지
  --   blocked   = robots/약관/권리 게이트에서 수집 불가로 판정
  --   pending   = 아직 확인 안 됨(초기 시드 상태). pending>0이면 '전수 완료' 판정 금지.
  status text NOT NULL CHECK (status IN ('resolved', 'missing', 'ambiguous', 'blocked', 'pending')),
  -- ambiguous/blocked/missing 사유. 조용한 누락 방지용 공개 목록의 근거가 된다.
  status_reason text,

  -- 증분 수집 축(§12 갱신): revision/contentHash 기반. 최초 시드에는 NULL.
  revision text,
  content_hash text,
  crawled_at timestamptz,
  -- 마지막 수집 시도(성공/실패 무관). 재수집 큐 우선순위 판단용.
  last_attempt_at timestamptz,
  failure_reason text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- 한 엔티티는 소스별로 1행(같은 선수의 KBO 기록실 행 + 나무위키 행은 공존).
  UNIQUE (entity_type, entity_id, source_kind)
);

COMMENT ON TABLE public.genius_source_inventory IS
  '야잘알봇 v2 RAG 소스 인벤토리 SSOT (rev0.7 §12). status pending>0이면 전수 완료 판정 금지. service_role 전용.';

CREATE INDEX IF NOT EXISTS idx_genius_source_inventory_status
  ON public.genius_source_inventory (status, entity_type);

-- ---------------------------------------------------------------------------
-- 2) RAG chunk 스토어 — 서술형 hybrid retrieval 대상
-- ---------------------------------------------------------------------------
-- 임베딩 차원 768 = Gemini text-embedding-004 기본 차원.
-- 코드 상수(RAG_EMBEDDING_DIM)와 이 값의 drift는 스모크(qa:genius-rag)가 차단한다.
CREATE TABLE IF NOT EXISTS public.genius_rag_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_id uuid NOT NULL REFERENCES public.genius_source_inventory(id) ON DELETE CASCADE,

  -- §12 chunk 메타 필수값 — 하나라도 결측이면 서빙 금지(코드 게이트가 강제).
  entity_type text NOT NULL CHECK (entity_type IN ('league', 'team', 'player', 'record_book')),
  entity_id text NOT NULL,
  page_title text NOT NULL,
  canonical_url text NOT NULL,
  revision text NOT NULL,
  section_path text NOT NULL,
  crawled_at timestamptz NOT NULL,
  content_hash text NOT NULL,
  source_grade text NOT NULL CHECK (source_grade IN ('tier1', 'tier2')),
  -- 기준시각. 답변에 asOf로 노출된다.
  as_of timestamptz NOT NULL,

  -- 원문 장문 보존 금지(§5, §12.2-b): retrieval 최소 단위의 재서술 가능한 chunk만 저장.
  content text NOT NULL,
  content_chars integer NOT NULL CHECK (content_chars > 0),
  -- 삭제·이동 tombstone(§12 갱신). true면 retrieval 대상에서 제외.
  tombstoned boolean NOT NULL DEFAULT false,

  embedding vector(768),
  embedded_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),

  -- 같은 문서의 같은 섹션·같은 내용은 1행(증분 재수집 시 upsert 키).
  UNIQUE (inventory_id, section_path, content_hash)
);

COMMENT ON TABLE public.genius_rag_chunks IS
  '야잘알봇 v2 RAG 서술형 chunk (rev0.7 §12). tier2 수치는 tier1 교차검증 전 확정 claim 금지. service_role 전용.';

-- entity filter + hybrid retrieval 진입 인덱스(§12 검색: entity filter 먼저).
CREATE INDEX IF NOT EXISTS idx_genius_rag_chunks_entity
  ON public.genius_rag_chunks (entity_type, entity_id)
  WHERE tombstoned = false;

-- ⚠️ 벡터 ANN 인덱스(ivfflat/hnsw)는 이 마이그레이션에서 만들지 않는다.
-- ivfflat은 대표벡터 학습에 실데이터가 필요해 빈 테이블에 만들면 리콜이 무너진다.
-- 대량 ingestion(S2a 실행분) 이후 별도 마이그레이션에서 데이터 규모를 보고 추가한다.

-- ---------------------------------------------------------------------------
-- 3) RLS — 운영 내부 파이프라인 자산. service_role 전용.
-- ---------------------------------------------------------------------------
-- 근거: inventory status/신뢰등급은 답변 신뢰성 게이트의 입력이라 클라이언트 직접 조작을
-- 허용하면 tier2 수치를 tier1로 승격시키는 우회가 생긴다. 서빙은 서버 경로로만 한다.
ALTER TABLE public.genius_source_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.genius_rag_chunks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.genius_source_inventory FROM public, anon, authenticated;
REVOKE ALL ON public.genius_rag_chunks FROM public, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.genius_source_inventory TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.genius_rag_chunks TO service_role;
