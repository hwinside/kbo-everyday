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
  -- null은 검증 전 운영 상태다. 전수 완료 판정은 null=0일 때만 가능하다.
  resolution_status text CHECK (resolution_status IN ('resolved', 'missing', 'ambiguous', 'blocked')),
  resolution_note text,
  source_grade text NOT NULL CHECK (source_grade IN ('tier1', 'tier2')),
  ingestion_status text NOT NULL DEFAULT 'not_started' CHECK (
    ingestion_status IN ('not_started', 'ingesting', 'ready', 'failed', 'stale', 'tombstoned')
  ),
  ingestion_attempts integer NOT NULL DEFAULT 0 CHECK (ingestion_attempts BETWEEN 0 AND 3),
  lease_until timestamptz,
  claim_token uuid,
  claim_generation bigint NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  revision text,
  content_hash text,
  crawled_at timestamptz,
  ingested_at timestamptz,
  stale_after timestamptz,
  tombstoned_at timestamptz,
  question_count bigint NOT NULL DEFAULT 0 CHECK (question_count >= 0),
  last_question_at timestamptz,
  last_error text,
  identity_fingerprint text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, entity_type, entity_id),
  UNIQUE (source_key, source_kind),
  CHECK (
    (source_kind = 'kbo_structured' AND source_grade = 'tier1')
    OR (source_kind = 'namu_document' AND source_grade = 'tier2')
  ),
  CHECK (resolution_status IS DISTINCT FROM 'resolved' OR canonical_url IS NOT NULL),
  CHECK (
    ingestion_status IS DISTINCT FROM 'ready'
    OR (
      source_kind = 'namu_document'
      AND resolution_status = 'resolved'
      AND canonical_url IS NOT NULL
      AND revision IS NOT NULL
      AND content_hash IS NOT NULL
      AND crawled_at IS NOT NULL
      AND ingested_at IS NOT NULL
      AND claim_token IS NULL
      AND lease_until IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_genius_rag_sources_ingestion_queue
  ON public.genius_rag_sources (
    question_count DESC,
    last_question_at DESC NULLS LAST,
    source_key
  )
  WHERE source_kind = 'namu_document'
    AND resolution_status = 'resolved'
    AND canonical_url IS NOT NULL
    AND ingestion_attempts < 3
    AND ingestion_status IN ('not_started', 'failed', 'stale', 'ingesting');

CREATE TABLE IF NOT EXISTS public.genius_rag_chunks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_key text NOT NULL,
  source_kind text NOT NULL DEFAULT 'namu_document' CHECK (source_kind = 'namu_document'),
  entity_type text NOT NULL CHECK (entity_type IN ('league', 'team', 'player')),
  entity_id text NOT NULL,
  page_title text NOT NULL,
  canonical_url text NOT NULL,
  revision text NOT NULL,
  section_path text NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content text NOT NULL CHECK (char_length(content) BETWEEN 40 AND 900),
  content_chars integer GENERATED ALWAYS AS (char_length(content)) STORED,
  document_content_hash text NOT NULL,
  content_hash text NOT NULL,
  source_grade text NOT NULL CHECK (source_grade = 'tier2'),
  crawled_at timestamptz NOT NULL,
  as_of date NOT NULL,
  claim_token uuid NOT NULL,
  claim_generation bigint NOT NULL CHECK (claim_generation > 0),
  -- embedding NULL은 검색 불가능한 chunk다. nullable로 두면 embedding을 생략한 chunk가
  -- ready 판정의 "matching chunk 존재"를 만족시켜 NULL 문서가 ready로 오인된다.
  embedding extensions.vector(768) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (source_key, source_kind)
    REFERENCES public.genius_rag_sources(source_key, source_kind) ON DELETE CASCADE,
  UNIQUE (source_key, revision, section_path, chunk_index)
);

CREATE OR REPLACE FUNCTION public.invalidate_baseball_genius_rag_identity_drift()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.identity_fingerprint IS DISTINCT FROM NEW.identity_fingerprint THEN
    DELETE FROM public.genius_rag_chunks WHERE source_key = OLD.source_key;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_invalidate_baseball_genius_rag_identity_drift
  BEFORE UPDATE OF identity_fingerprint ON public.genius_rag_sources
  FOR EACH ROW EXECUTE FUNCTION public.invalidate_baseball_genius_rag_identity_drift();

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
    OR v_source.source_kind <> 'namu_document'
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
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_baseball_genius_rag_chunk_owner
  BEFORE INSERT OR UPDATE ON public.genius_rag_chunks
  FOR EACH ROW EXECUTE FUNCTION public.validate_baseball_genius_rag_chunk_owner();

CREATE OR REPLACE FUNCTION public.validate_baseball_genius_rag_ready()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.ingestion_status = 'ready' AND NOT EXISTS (
    SELECT 1
    FROM public.genius_rag_chunks chunk
    WHERE chunk.source_key = NEW.source_key
      AND chunk.revision = NEW.revision
      AND chunk.document_content_hash = NEW.content_hash
      AND chunk.entity_type = NEW.entity_type
      AND chunk.entity_id = NEW.entity_id
      AND chunk.page_title = NEW.page_title
      AND chunk.canonical_url = NEW.canonical_url
      AND chunk.source_grade = NEW.source_grade
      AND chunk.crawled_at = NEW.crawled_at
      AND chunk.embedding IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'ready rag source requires matching provenance chunk';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_baseball_genius_rag_ready
  BEFORE INSERT OR UPDATE ON public.genius_rag_sources
  FOR EACH ROW EXECUTE FUNCTION public.validate_baseball_genius_rag_ready();

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
    WHERE source.source_kind = 'namu_document'
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
  -- crash한 이전 generation이 남긴 chunk를 reclaim 시점에 정리한다.
  -- 이걸 안 하면 gen2가 같은 (revision, section_path, chunk_index)를 쓸 때 UNIQUE 충돌로
  -- 재수집이 영구히 실패하고 source가 ingesting에 갇힌다.
  purged AS (
    DELETE FROM public.genius_rag_chunks chunk
    USING claimed
    WHERE chunk.source_key = claimed.source_key
      AND chunk.claim_generation < claimed.claim_generation
    RETURNING chunk.id
  )
  SELECT claimed.* FROM claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_baseball_genius_rag_source(
  p_source_key text,
  p_claim_token uuid,
  p_claim_generation bigint,
  p_revision text,
  p_content_hash text,
  p_crawled_at timestamptz,
  p_stale_after timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_completed boolean;
BEGIN
  UPDATE public.genius_rag_sources source
  SET ingestion_status = 'ready',
      revision = p_revision,
      content_hash = p_content_hash,
      crawled_at = p_crawled_at,
      ingested_at = clock_timestamp(),
      stale_after = p_stale_after,
      lease_until = NULL,
      claim_token = NULL,
      last_error = NULL,
      updated_at = now()
  WHERE source.source_key = p_source_key
    AND source.ingestion_status = 'ingesting'
    AND source.claim_token = p_claim_token
    AND source.claim_generation = p_claim_generation
    AND source.lease_until > clock_timestamp()
    AND EXISTS (
      SELECT 1 FROM public.genius_rag_chunks chunk
      WHERE chunk.source_key = source.source_key
        AND chunk.claim_token = p_claim_token
        AND chunk.claim_generation = p_claim_generation
        AND chunk.revision = p_revision
        AND chunk.document_content_hash = p_content_hash
        AND chunk.crawled_at = p_crawled_at
        AND chunk.embedding IS NOT NULL
    )
    -- 검색 불가능한 chunk가 단 1건이라도 남아 있으면 ready로 올리지 않는다.
    AND NOT EXISTS (
      SELECT 1 FROM public.genius_rag_chunks chunk
      WHERE chunk.source_key = source.source_key
        AND chunk.claim_generation = p_claim_generation
        AND chunk.embedding IS NULL
    )
  RETURNING true INTO v_completed;

  RETURN coalesce(v_completed, false);
END;
$$;

-- worker의 유일한 chunk write 경로다.
-- (1) service_role은 genius_rag_chunks에 직접 INSERT 권한도 identity sequence USAGE도 없다.
--     SECURITY DEFINER RPC만 열어 claim token/generation 검증을 거친 write만 허용한다.
-- (2) gen1이 chunk를 남기고 crash한 뒤 lease 만료로 gen2가 reclaim하면 같은
--     (source_key, revision, section_path, chunk_index)를 다시 쓰게 되어 UNIQUE 충돌로 재수집이 영구 실패했다.
--     generation-safe replace로 더 새로운 generation만 기존 행을 덮어쓴다(오래된 worker의 역주행은 거부).
CREATE OR REPLACE FUNCTION public.upsert_baseball_genius_rag_chunk(
  p_source_key text,
  p_claim_token uuid,
  p_claim_generation bigint,
  p_entity_type text,
  p_entity_id text,
  p_page_title text,
  p_canonical_url text,
  p_revision text,
  p_section_path text,
  p_chunk_index integer,
  p_content text,
  p_document_content_hash text,
  p_content_hash text,
  p_source_grade text,
  p_crawled_at timestamptz,
  p_as_of date,
  p_embedding extensions.vector(768),
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id bigint;
BEGIN
  IF p_embedding IS NULL THEN
    RAISE EXCEPTION 'rag chunk requires embedding';
  END IF;

  INSERT INTO public.genius_rag_chunks (
    source_key, entity_type, entity_id, page_title, canonical_url, revision, section_path,
    chunk_index, content, document_content_hash, content_hash, source_grade, crawled_at, as_of,
    claim_token, claim_generation, embedding, metadata
  ) VALUES (
    p_source_key, p_entity_type, p_entity_id, p_page_title, p_canonical_url, p_revision, p_section_path,
    p_chunk_index, p_content, p_document_content_hash, p_content_hash, p_source_grade, p_crawled_at, p_as_of,
    p_claim_token, p_claim_generation, p_embedding, coalesce(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (source_key, revision, section_path, chunk_index) DO UPDATE
  SET entity_type = EXCLUDED.entity_type,
      entity_id = EXCLUDED.entity_id,
      page_title = EXCLUDED.page_title,
      canonical_url = EXCLUDED.canonical_url,
      content = EXCLUDED.content,
      document_content_hash = EXCLUDED.document_content_hash,
      content_hash = EXCLUDED.content_hash,
      source_grade = EXCLUDED.source_grade,
      crawled_at = EXCLUDED.crawled_at,
      as_of = EXCLUDED.as_of,
      claim_token = EXCLUDED.claim_token,
      claim_generation = EXCLUDED.claim_generation,
      embedding = EXCLUDED.embedding,
      metadata = EXCLUDED.metadata
  WHERE public.genius_rag_chunks.claim_generation < EXCLUDED.claim_generation
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'stale rag chunk generation for %', p_source_key;
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_baseball_genius_source_demand(p_source_keys text[])
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

  WITH requested AS (SELECT DISTINCT unnest(p_source_keys) AS source_key)
  UPDATE public.genius_rag_sources source
  SET question_count = source.question_count + 1,
      last_question_at = clock_timestamp(),
      updated_at = now()
  FROM requested
  WHERE source.source_key = requested.source_key;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

ALTER TABLE public.genius_rag_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.genius_rag_chunks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON FUNCTION public.claim_baseball_genius_rag_batch(integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_baseball_genius_rag_batch(integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.complete_baseball_genius_rag_source(text, uuid, bigint, text, text, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_baseball_genius_rag_source(text, uuid, bigint, text, text, timestamptz, timestamptz)
  TO service_role;
REVOKE ALL ON FUNCTION public.record_baseball_genius_source_demand(text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_baseball_genius_source_demand(text[]) TO service_role;
REVOKE ALL ON FUNCTION public.upsert_baseball_genius_rag_chunk(
  text, uuid, bigint, text, text, text, text, text, text, integer, text, text, text, text,
  timestamptz, date, extensions.vector(768), jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_baseball_genius_rag_chunk(
  text, uuid, bigint, text, text, text, text, text, text, integer, text, text, text, text,
  timestamptz, date, extensions.vector(768), jsonb
) TO service_role;
-- claim RPC는 genius_rag_sources 행 타입을 반환하므로 caller에게 row type 접근이 필요하다.
-- 쓰기는 열지 않고 SELECT만 부여한다(chunks 테이블 직접 write는 계속 차단).
GRANT SELECT ON public.genius_rag_sources TO service_role;
