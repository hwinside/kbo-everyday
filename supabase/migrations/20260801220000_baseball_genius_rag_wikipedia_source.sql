-- 야잘알봇 v2 S2b R3: tier2 소스에 **위키피디아를 기본 소스로 추가**한다.
-- 운영 DB 직접 적용 금지: PR 리뷰·머지·배포 게이트 뒤 적용한다.
--
-- 왜 (하린아빠 지시 2026-08-01 "위키피디아를 기본으로 하되"):
--   - 위키피디아(ko)는 공식 API를 정직한 UA plain fetch로 200 받는다 → **서버 런타임에서도 가능한 경로**.
--     revid가 API 응답에 있어 revision provenance가 추정이 아니라 정본이다.
--   - 나무위키는 실크롤에 Playwright(headed Chrome + 요청당 재기동 + 10초 간격)가 필요해
--     **수집 스크립트 전용**이며, 별명·팬덤 서술 같은 디테일 보충용 **보조** 소스다.
--
-- 계약은 그대로 유지된다: 두 소스 모두 tier2이므로 **수치를 확정하지 못한다**(§12 수치 계약).
-- 충돌 시 위키피디아 우선(코드: `orderTier2Evidence`), 출처 표기는 canonical URL로 항상 구분된다.
--
-- 이 마이그레이션은 **기존 행을 건드리지 않는다** — CHECK 확장 + 술어 확장뿐이다.
-- 멱등: 모든 문장이 DROP IF EXISTS / CREATE OR REPLACE / 조건부 재생성이다.

-- 1) source_kind 폐쇄집합 확장 -----------------------------------------------
ALTER TABLE public.genius_rag_sources
  DROP CONSTRAINT IF EXISTS genius_rag_sources_source_kind_check;
ALTER TABLE public.genius_rag_sources
  ADD CONSTRAINT genius_rag_sources_source_kind_check
  CHECK (source_kind IN ('kbo_structured', 'namu_document', 'wikipedia_document'));

-- 원본 테이블의 인라인 CHECK 2건(tier 매핑 / ready provenance)은 **자동 생성 이름**을 갖는다
-- (`genius_rag_sources_check`, `..._check2`). 이름을 하드코딩하면 환경마다 번호가 달라 조용히
-- 안 지워지고, 옛 술어가 그대로 남아 wikipedia_document 행이 거부된다(실제로 이 함정을 밟았다).
-- 그래서 **정의로 찾아 지운다**: 'namu_document'를 언급하지만 'wikipedia_document'는 모르는 CHECK.
DO $$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.genius_rag_sources'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%namu_document%'
      AND pg_get_constraintdef(oid) NOT LIKE '%wikipedia_document%'
  LOOP
    EXECUTE format('ALTER TABLE public.genius_rag_sources DROP CONSTRAINT %I', v_name);
  END LOOP;
END;
$$;

-- tier 매핑: 위키피디아도 tier2다(공식 KBO만 tier1).
ALTER TABLE public.genius_rag_sources
  DROP CONSTRAINT IF EXISTS genius_rag_sources_grade_by_kind_check;
ALTER TABLE public.genius_rag_sources
  ADD CONSTRAINT genius_rag_sources_grade_by_kind_check
  CHECK (
    (source_kind = 'kbo_structured' AND source_grade = 'tier1')
    OR (source_kind IN ('namu_document', 'wikipedia_document') AND source_grade = 'tier2')
  );

-- ready 계약: 문서형 소스(namu/wikipedia) 모두에 동일하게 적용한다.
ALTER TABLE public.genius_rag_sources
  DROP CONSTRAINT IF EXISTS genius_rag_sources_ready_provenance_check;
ALTER TABLE public.genius_rag_sources
  ADD CONSTRAINT genius_rag_sources_ready_provenance_check
  CHECK (
    ingestion_status IS DISTINCT FROM 'ready'
    OR (
      source_kind IN ('namu_document', 'wikipedia_document')
      AND resolution_status = 'resolved'
      AND canonical_url IS NOT NULL
      AND revision IS NOT NULL
      AND content_hash IS NOT NULL
      AND crawled_at IS NOT NULL
      AND ingested_at IS NOT NULL
      AND claim_token IS NULL
      AND lease_until IS NULL
      AND active_claim_generation > 0
    )
  );

-- 2) chunk source_kind 확장 ---------------------------------------------------
DO $$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.genius_rag_chunks'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%namu_document%'
      AND pg_get_constraintdef(oid) NOT LIKE '%wikipedia_document%'
  LOOP
    EXECUTE format('ALTER TABLE public.genius_rag_chunks DROP CONSTRAINT %I', v_name);
  END LOOP;
END;
$$;
ALTER TABLE public.genius_rag_chunks
  DROP CONSTRAINT IF EXISTS genius_rag_chunks_source_kind_check;
ALTER TABLE public.genius_rag_chunks
  ADD CONSTRAINT genius_rag_chunks_source_kind_check
  CHECK (source_kind IN ('namu_document', 'wikipedia_document'));

-- 3) ingestion 큐 인덱스 — 문서형 소스 전체를 대상으로 --------------------------
DROP INDEX IF EXISTS public.idx_genius_rag_sources_ingestion_queue;
CREATE INDEX IF NOT EXISTS idx_genius_rag_sources_ingestion_queue
  ON public.genius_rag_sources (
    question_count DESC,
    last_question_at DESC NULLS LAST,
    source_key
  )
  WHERE source_kind IN ('namu_document', 'wikipedia_document')
    AND resolution_status = 'resolved'
    AND canonical_url IS NOT NULL
    AND ingestion_attempts < 3
    AND ingestion_status IN ('not_started', 'failed', 'stale', 'ingesting');

-- 4) chunk owner 검증 — 문서형 소스 전체 ---------------------------------------
-- 원본과 달라지는 것: (i) 허용 source_kind 집합 확장, (ii) chunk의 source_kind를 **소스에서 파생**시킨다.
-- (ii)가 필요한 이유: chunk.source_kind는 컬럼 기본값('namu_document')으로 들어오는데, 소스가
-- wikipedia_document면 FK(source_key, source_kind)가 깨지고 남의 종류로 귀속된다. 호출자가 종류를
-- 따로 주장하게 두는 대신 소스 행에서 복사한다 — 귀속을 호출자가 정하지 못하게 하는 쪽이 안전하다.
-- 나머지 술어(claim/lease/provenance 대조)는 글자 그대로 동일하다.
CREATE OR REPLACE FUNCTION public.validate_baseball_genius_rag_chunk_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_source public.genius_rag_sources%ROWTYPE;
BEGIN
  SELECT * INTO v_source
  FROM public.genius_rag_sources
  WHERE source_key = NEW.source_key
  FOR SHARE;

  IF v_source.source_key IS NULL
    OR v_source.source_kind NOT IN ('namu_document', 'wikipedia_document')
    OR v_source.resolution_status <> 'resolved'
    OR v_source.canonical_url IS NULL
    OR v_source.ingestion_status <> 'ingesting'
    OR v_source.claim_token IS DISTINCT FROM NEW.claim_token
    OR v_source.claim_generation <> NEW.claim_generation
    OR v_source.lease_until IS NULL
    OR v_source.lease_until <= clock_timestamp()
    OR v_source.entity_type <> NEW.entity_type
    OR v_source.entity_id <> NEW.entity_id
    OR v_source.page_title <> NEW.page_title
    OR v_source.canonical_url <> NEW.canonical_url
    OR v_source.source_grade <> NEW.source_grade
  THEN
    RAISE EXCEPTION 'stale or mismatched rag chunk owner/provenance';
  END IF;
  -- 귀속은 소스가 정한다: chunk의 source_kind를 소스 행에서 그대로 파생시킨다.
  NEW.source_kind := v_source.source_kind;
  RETURN NEW;
END;
$$;

-- 5) claim RPC 2종 — 문서형 소스 전체를 후보로 ---------------------------------
-- 원본(20260731 / 20260801 scoped)에서 **source_kind 조건 한 줄만** 확장했다.
-- stage→swap·purge·retry 예산 계약은 글자 그대로 동일하다 — 여기서 계약을 바꾸지 않는다.
CREATE OR REPLACE FUNCTION public.claim_baseball_genius_rag_batch(
  p_limit integer,
  p_lease_seconds integer DEFAULT 300
)
RETURNS SETOF public.genius_rag_sources
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 50 OR p_lease_seconds < 30 OR p_lease_seconds > 1800 THEN
    RAISE EXCEPTION 'invalid rag batch bounds';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT source.source_key AS source_key
    FROM public.genius_rag_sources source
    WHERE source.source_kind IN ('namu_document', 'wikipedia_document')
      AND source.resolution_status = 'resolved'
      AND source.canonical_url IS NOT NULL
      AND source.tombstoned_at IS NULL
      AND source.ingestion_attempts < 3
      AND (
        source.ingestion_status IN ('not_started', 'stale', 'failed')
        OR (
          source.ingestion_status = 'ingesting'
          AND source.lease_until IS NOT NULL
          AND source.lease_until < clock_timestamp()
        )
      )
    ORDER BY source.question_count DESC, source.last_question_at DESC NULLS LAST, source.source_key
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ),
  claimed AS (
    UPDATE public.genius_rag_sources source
    SET ingestion_status = 'ingesting',
        ingestion_attempts = source.ingestion_attempts + 1,
        lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
        claim_token = gen_random_uuid(),
        claim_generation = source.claim_generation + 1,
        last_error = NULL,
        updated_at = now()
    FROM candidates candidate
    WHERE source.source_key = candidate.source_key
    RETURNING source.*
  ),
  -- claim은 새 generation을 stage만 한다. 마지막 성공 snapshot(active generation)은 절대 지우지 않는다.
  -- 여기서 정리하는 대상은 complete에 도달하지 못한 미완성 generation(실패/lease 만료 partial)뿐이다.
  -- §12 "마지막 성공 snapshot 보존": gen1 ready → source stale → gen2 claim 시에도 gen1 chunk는
  -- gen2가 complete되어 active가 swap될 때까지 그대로 남아 서빙된다.
  purged AS (
    DELETE FROM public.genius_rag_chunks chunk
    USING claimed
    WHERE chunk.source_key = claimed.source_key
      AND chunk.claim_generation < claimed.claim_generation
      AND chunk.claim_generation <> claimed.active_claim_generation
    RETURNING chunk.id
  )
  SELECT claimed.* FROM claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_baseball_genius_rag_batch_scoped(
  p_limit integer,
  p_lease_seconds integer,
  p_source_keys text[]
)
RETURNS SETOF public.genius_rag_sources
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 50 OR p_lease_seconds < 30 OR p_lease_seconds > 1800 THEN
    RAISE EXCEPTION 'invalid rag batch bounds';
  END IF;
  -- 빈/NULL 범위를 "전체"로 해석하면 범위 게이트가 조용히 사라진다. 명시 거부한다.
  IF p_source_keys IS NULL OR cardinality(p_source_keys) = 0 THEN
    RAISE EXCEPTION 'scoped rag claim requires a non-empty source key scope';
  END IF;
  -- 범위 자체도 bounded여야 한다(슬라이스 계약). 상한은 claim 상한과 무관하게 목록 크기다.
  IF cardinality(p_source_keys) > 1000 THEN
    RAISE EXCEPTION 'rag claim scope too large';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT source.source_key AS source_key
    FROM public.genius_rag_sources source
    WHERE source.source_kind IN ('namu_document', 'wikipedia_document')
      -- ▼ 범위 게이트: claim 이전에 대상 밖을 제외한다(운영 source 손상 방지).
      AND source.source_key = ANY (p_source_keys)
      AND source.resolution_status = 'resolved'
      AND source.canonical_url IS NOT NULL
      AND source.tombstoned_at IS NULL
      AND source.ingestion_attempts < 3
      AND (
        source.ingestion_status IN ('not_started', 'stale', 'failed')
        OR (
          source.ingestion_status = 'ingesting'
          AND source.lease_until IS NOT NULL
          AND source.lease_until < clock_timestamp()
        )
      )
    ORDER BY source.question_count DESC, source.last_question_at DESC NULLS LAST, source.source_key
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ),
  claimed AS (
    UPDATE public.genius_rag_sources source
    SET ingestion_status = 'ingesting',
        ingestion_attempts = source.ingestion_attempts + 1,
        lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
        claim_token = gen_random_uuid(),
        claim_generation = source.claim_generation + 1,
        last_error = NULL,
        updated_at = now()
    FROM candidates candidate
    WHERE source.source_key = candidate.source_key
    RETURNING source.*
  ),
  -- 기존 claim RPC와 동일한 stage 정리 계약: 마지막 성공 snapshot(active generation)은 보존하고,
  -- complete에 도달하지 못한 미완성 generation만 지운다(§12).
  purged AS (
    DELETE FROM public.genius_rag_chunks chunk
    USING claimed
    WHERE chunk.source_key = claimed.source_key
      AND chunk.claim_generation < claimed.claim_generation
      AND chunk.claim_generation <> claimed.active_claim_generation
    RETURNING chunk.id
  )
  SELECT claimed.* FROM claimed;
END;
$$;
