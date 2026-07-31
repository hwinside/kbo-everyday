-- 야잘알봇 v2 S1b/S2 source inventory + 질문 수요순 ingestion 기반.
-- 운영 DB 직접 적용 금지: PR 리뷰·머지·배포 게이트 뒤 적용한다.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.genius_rag_sources (
  source_key text PRIMARY KEY,
  source_kind text NOT NULL CHECK (source_kind IN ('kbo_structured', 'namu_document')),
  entity_type text NOT NULL CHECK (entity_type IN ('record_category', 'league', 'team', 'player')),
  entity_id text NOT NULL,
  page_title text NOT NULL,
  candidate_urls text[] NOT NULL CHECK (cardinality(candidate_urls) > 0),
  canonical_url text,
  -- null은 아직 검증 전인 운영 상태다. 전수 완료 판정은 null=0일 때만 가능하다.
  resolution_status text CHECK (resolution_status IN ('resolved', 'missing', 'ambiguous', 'blocked')),
  resolution_note text,
  source_grade text NOT NULL CHECK (source_grade IN ('official', 'secondary')),
  ingestion_status text NOT NULL DEFAULT 'not_started' CHECK (
    ingestion_status IN ('not_started', 'queued', 'ingesting', 'ready', 'failed', 'stale', 'tombstoned')
  ),
  ingestion_attempts integer NOT NULL DEFAULT 0 CHECK (ingestion_attempts >= 0),
  lease_until timestamptz,
  revision text,
  content_hash text,
  crawled_at timestamptz,
  ingested_at timestamptz,
  stale_after timestamptz,
  tombstoned_at timestamptz,
  question_count bigint NOT NULL DEFAULT 0 CHECK (question_count >= 0),
  last_question_at timestamptz,
  last_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_genius_rag_sources_ingestion_queue
  ON public.genius_rag_sources (
    question_count DESC,
    last_question_at DESC NULLS LAST,
    source_key
  )
  WHERE source_kind = 'namu_document'
    AND resolution_status = 'resolved'
    AND ingestion_status IN ('not_started', 'failed', 'stale');

CREATE TABLE IF NOT EXISTS public.genius_rag_chunks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_key text NOT NULL REFERENCES public.genius_rag_sources(source_key) ON DELETE CASCADE,
  revision text NOT NULL,
  section_path text NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content text NOT NULL CHECK (length(content) > 0),
  content_hash text NOT NULL,
  -- 모델·차원 확정 전이라 무차원 vector로 저장하고, 서빙 인덱스는 후속 PR에서 모델과 결속한다.
  embedding extensions.vector,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_key, revision, section_path, chunk_index)
);

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
    SELECT source.source_key
    FROM public.genius_rag_sources source
    WHERE source.source_kind = 'namu_document'
      AND source.resolution_status = 'resolved'
      AND source.tombstoned_at IS NULL
      AND (
        source.ingestion_status IN ('not_started', 'stale')
        OR (source.ingestion_status = 'failed' AND source.ingestion_attempts < 3)
        OR (source.ingestion_status = 'ingesting' AND source.lease_until < clock_timestamp())
      )
    ORDER BY source.question_count DESC, source.last_question_at DESC NULLS LAST, source.source_key
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE public.genius_rag_sources s
  SET ingestion_status = 'ingesting',
      ingestion_attempts = s.ingestion_attempts + 1,
      lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
      last_error = NULL,
      updated_at = now()
  FROM candidates c
  WHERE s.source_key = c.source_key
  RETURNING s.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_baseball_genius_source_demand(
  p_source_keys text[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  IF cardinality(p_source_keys) IS NULL OR cardinality(p_source_keys) < 1 OR cardinality(p_source_keys) > 20 THEN
    RAISE EXCEPTION 'invalid source demand bounds';
  END IF;

  WITH requested AS (
    SELECT DISTINCT unnest(p_source_keys) AS source_key
  )
  UPDATE public.genius_rag_sources s
  SET question_count = s.question_count + 1,
      last_question_at = clock_timestamp(),
      updated_at = now()
  FROM requested r
  WHERE s.source_key = r.source_key;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

ALTER TABLE public.genius_rag_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.genius_rag_chunks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON FUNCTION public.claim_baseball_genius_rag_batch(integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_baseball_genius_rag_batch(integer, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.record_baseball_genius_source_demand(text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_baseball_genius_source_demand(text[])
  TO service_role;
