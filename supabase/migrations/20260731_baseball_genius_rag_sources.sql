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
  -- 서빙 중인 generation(= 마지막으로 complete에 성공한 generation). §12 "마지막 성공 snapshot 보존" 계약의
  -- 저장소다. claim은 새 generation을 stage만 하고 이 값을 건드리지 않으며, complete가 원자적으로 swap한다.
  -- 0은 아직 성공 snapshot이 없다는 뜻이다.
  active_claim_generation bigint NOT NULL DEFAULT 0 CHECK (active_claim_generation >= 0),
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
      AND active_claim_generation > 0
    )
  ),
  CHECK (active_claim_generation <= claim_generation)
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
  -- generation을 UNIQUE 키에 포함해야 stage→swap이 성립한다. generation이 빠져 있으면 재수집(gen2)이
  -- 같은 (revision, section_path, chunk_index)를 쓸 때 서빙 중인 gen1 행을 덮어써서
  -- complete 전에 마지막 성공 snapshot이 파괴된다(§12 위반). 두 generation은 별도 행으로 공존하고,
  -- complete 시점에만 active가 전환되며 비활성 generation이 정리된다.
  UNIQUE (source_key, claim_generation, revision, section_path, chunk_index)
);

-- 서빙 조건을 generation에 결속한다: **active generation chunk만** retrieval 대상이다.
-- stage 중인 새 generation(미완성)은 complete 전까지 이 뷰에 절대 나타나지 않는다.
-- 반대로 source가 재수집으로 'ingesting'이 되어도 마지막 성공 snapshot은 계속 서빙된다
-- (§12 "마지막 성공 snapshot 보존"). 서빙 기준은 ingestion_status가 아니라 active snapshot 존재여부다.
-- SECURITY DEFINER 뷰다(security_invoker 미지정) — service_role은 genius_rag_chunks에 직접 SELECT 권한이
-- 없으므로 이 뷰가 유일한 읽기 경로이며, generation 결속을 우회할 수 없다.
CREATE OR REPLACE VIEW public.genius_rag_serving_chunks AS
SELECT chunk.*
FROM public.genius_rag_chunks chunk
JOIN public.genius_rag_sources source
  ON source.source_key = chunk.source_key
 WHERE source.tombstoned_at IS NULL
   AND source.active_claim_generation > 0
   AND chunk.claim_generation = source.active_claim_generation;

CREATE OR REPLACE FUNCTION public.invalidate_baseball_genius_rag_identity_drift()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.identity_fingerprint IS DISTINCT FROM NEW.identity_fingerprint THEN
    DELETE FROM public.genius_rag_chunks WHERE source_key = OLD.source_key;
    -- chunk를 전량 삭제했으므로 서빙 중이던 snapshot도 사라졌다. active를 같이 내리지 않으면
    -- ready 계약(active_claim_generation > 0 + matching chunk 존재)을 즉시 위반해
    -- ready source에 대한 drift UPDATE 자체가 'ready rag source requires matching provenance chunk'로
    -- 거부된다(= 이름/소속이 바뀜 문서를 영원히 무효화할 수 없음). 서빙 가능한 snapshot이
    -- 없으므로 active를 0으로 내리고 ready는 재수집 대상(stale)으로 강등시킨다.
    NEW.active_claim_generation := 0;
    IF NEW.ingestion_status = 'ready' THEN
      NEW.ingestion_status := 'stale';
    END IF;
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
      -- ready는 active generation에만 근거한다(서빙 조건 = generation 결속).
      AND chunk.claim_generation = NEW.active_claim_generation
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
      -- retry budget은 "연속 실패" 카운터다. lifetime 누적이면 성공한 source도 3세대 만에
      -- 예산이 말라 stale 재claim이 영구히 0건이 되어 §12 증분 재수집이 정지한다.
      -- 성공(complete)했다는 것은 그 source가 수집 가능하다는 증거이므로 예산을 회복시킨다.
      -- 무한 재시도 방지 계약은 그대로다: 성공 없이 연속 3회 실패하면 여전히 소진된다.
      ingestion_attempts = 0,
      -- stage→swap: 이 시점에만 active generation이 새 generation으로 원자 전환된다.
      active_claim_generation = p_claim_generation,
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
    -- current claim generation의 **모든** chunk가 동일 provenance여야 한다.
    -- 이질 revision/document_content_hash/crawled_at/claim_token이 섞이거나 embedding이 NULL인
    -- chunk가 단 1건이라도 있으면 ready로 올리지 않는다(검색 불가 chunk + 오염된 snapshot 차단).
    AND NOT EXISTS (
      SELECT 1 FROM public.genius_rag_chunks chunk
      WHERE chunk.source_key = source.source_key
        AND chunk.claim_generation = p_claim_generation
        AND (
          chunk.embedding IS NULL
          OR chunk.claim_token IS DISTINCT FROM p_claim_token
          OR chunk.revision IS DISTINCT FROM p_revision
          OR chunk.document_content_hash IS DISTINCT FROM p_content_hash
          OR chunk.crawled_at IS DISTINCT FROM p_crawled_at
        )
    )
  RETURNING true INTO v_completed;

  IF coalesce(v_completed, false) THEN
    -- swap 완료 후에야 비활성 generation(이전 snapshot 포함)을 정리한다.
    -- 순서가 반대였으면 swap 전에 마지막 성공 snapshot이 사라져 서빙 공백이 생긴다.
    DELETE FROM public.genius_rag_chunks chunk
    WHERE chunk.source_key = p_source_key
      AND chunk.claim_generation <> p_claim_generation;
  END IF;

  RETURN coalesce(v_completed, false);
END;
$$;

-- worker의 유일한 chunk write 경로다.
-- (1) service_role은 genius_rag_chunks에 직접 INSERT 권한도 identity sequence USAGE도 없다.
--     SECURITY DEFINER RPC만 열어 claim token/generation 검증을 거친 write만 허용한다.
-- (2) gen1이 chunk를 남기고 crash한 뒤 lease 만료로 gen2가 reclaim해도 UNIQUE 키에 claim_generation이
--     포함되어 있으므로 두 generation이 별도 행으로 공존한다(stage). 서빙 중인 이전 snapshot을
--     덮어쓰지 않으며, active 전환은 complete RPC가 원자적으로 수행한다.
-- (3) DB commit 후 응답이 timeout되면 worker는 결과를 모른다. 같은 claim(동일 generation + 동일 token)의
--     재시도는 idempotent update로 성공해야 하며, 낮은 generation이나 다른 token은 거부한다.
--     낮은 generation 역주행은 UNIQUE 키가 달라 애초에 충돌하지 않고, chunk owner trigger의
--     claim_generation 검증이 거부한다.
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
  ON CONFLICT (source_key, claim_generation, revision, section_path, chunk_index) DO UPDATE
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
  -- UNIQUE 키에 claim_generation이 있으므로 충돌 행은 항상 같은 generation이다.
  -- 그중 같은 claim_token일 때만 idempotent 재시도로 허용하고, 다른 token의 덮어쓰기는 거부한다.
  WHERE public.genius_rag_chunks.claim_token = EXCLUDED.claim_token
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'stale rag chunk generation for %', p_source_key;
  END IF;
  RETURN v_id;
END;
$$;

-- worker의 실패 종료 경로다. 이것이 없으면 claim한 worker가 실패했을 때 source를 'ingesting'에서
-- 내릴 수단이 아예 없다. lease 만료를 기다려 재claim되더라도 attempts는 매번 증가하므로
-- 연속 3회 실패 시점에 **`ingesting` + `last_error` NULL + claim_token 잔존 + claimable 0**으로
-- 영구 고착된다(PG17 actual 재현). 운영자는 진행 중인 claim과 죽은 claim을 구분할 수도 없다.
-- 이 RPC는 exact token + generation이 일치하는 **그 claim만** 실패 처리한다:
--   (1) last_error를 남겨 실패 사유를 관측 가능하게 하고,
--   (2) lease/token을 비워 'ingesting' 고착을 풀며,
--   (3) 상태를 'failed'로 내려 예산이 남아 있으면(attempts < 3) lease 만료를 기다리지 않고 즉시 재claim된다.
-- 무한 재시도 방지 계약은 그대로다: attempts는 리셋하지 않으므로 성공 없이 연속 3회 실패하면
-- 여전히 예산이 소진된다(복구는 성공 complete만이 한다).
-- lease가 이미 만료됐어도 종료를 허용한다. 만료를 조건으로 걸면 위 고착 상태(만료 + 예산 소진)를
-- 영원히 정리할 수 없기 때문이다. 그 사이 다른 worker가 reclaim했다면 generation이 올라가
-- token/generation 불일치로 자동 no-op이 된다(남의 claim을 실패시키지 못한다).
CREATE OR REPLACE FUNCTION public.fail_baseball_genius_rag_source(
  p_source_key text,
  p_claim_token uuid,
  p_claim_generation bigint,
  p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_failed boolean;
  v_active bigint;
BEGIN
  UPDATE public.genius_rag_sources source
  SET ingestion_status = 'failed',
      last_error = left(coalesce(nullif(btrim(p_error), ''), 'unspecified ingestion failure'), 500),
      lease_until = NULL,
      claim_token = NULL,
      updated_at = now()
  WHERE source.source_key = p_source_key
    AND source.ingestion_status = 'ingesting'
    AND source.claim_token = p_claim_token
    AND source.claim_generation = p_claim_generation
  RETURNING true, source.active_claim_generation INTO v_failed, v_active;

  IF coalesce(v_failed, false) THEN
    -- 실패한 generation이 남긴 미완성 chunk를 정리한다. 마지막 성공 snapshot(active generation)은
    -- 절대 건드리지 않는다(§12) — 재수집이 실패해도 직전 성공본은 계속 서빙되어야 한다.
    DELETE FROM public.genius_rag_chunks chunk
    WHERE chunk.source_key = p_source_key
      AND chunk.claim_generation = p_claim_generation
      AND chunk.claim_generation <> v_active;
  END IF;

  RETURN coalesce(v_failed, false);
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
REVOKE ALL ON FUNCTION public.fail_baseball_genius_rag_source(text, uuid, bigint, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_baseball_genius_rag_source(text, uuid, bigint, text) TO service_role;
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
-- retrieval은 active generation에 결속된 서빙 뷰만 읽는다. 기반 chunks 테이블 직접 접근은 여전히 닫혀 있어
-- stage 중인 미완성 generation이 검색에 새어나갈 경로가 없다.
REVOKE ALL ON public.genius_rag_serving_chunks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.genius_rag_serving_chunks TO service_role;
