-- 야잘알봇 RAG: 적재 완료(swap)를 **기대 chunk 수와 원자적으로** 묶는다 (2026-08-02).
--
-- 사고(삼순 R4 #1050-2): 로더는 complete RPC로 새 generation을 active 로 swap 하고
-- **이전 generation 을 삭제한 뒤에** count 를 셌다. 불일치를 발견해도 이미 늦다:
--   - fail RPC 는 `ingestion_status='ingesting'` + 동일 token 조건이라 READY 행에 no-op
--   - 프로세스가 exit 1 이어도 불일치 snapshot 은 active 로 남고
--   - 직전 정상본(last-good)은 이미 지워졌다
--
-- 해결: 기대 수를 complete 의 **원자 조건**으로 넣는다. 불일치면 UPDATE 0행 → swap 0,
-- 이전 generation 삭제 0 → last-good snapshot 이 그대로 서빙된다.

-- ── 공식 e북 source 원자 ensure ─────────────────────────────────────────────
-- 로더가 source seed SQL을 파일로만 만들고 실제 DB에는 적용하지 않아, 새 환경에서는
-- claim 0건으로 전량 스킵됐다. source 생성과 적재를 한 실행축에 묶되 기존 active snapshot과
-- loaderRevision은 보존한다. 입력이 하나라도 계약 밖이면 함수 전체가 롤백된다.
CREATE OR REPLACE FUNCTION public.ensure_baseball_genius_ebook_sources(p_sources jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_expected integer;
  v_affected integer;
BEGIN
  IF p_sources IS NULL OR jsonb_typeof(p_sources) <> 'array' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'sources must be a json array';
  END IF;
  v_expected := jsonb_array_length(p_sources);
  IF v_expected < 1 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'sources must not be empty';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_sources) AS item(value)
    WHERE value->>'source_kind' IS DISTINCT FROM 'kbo_ebook'
       OR value->>'entity_type' IS DISTINCT FROM 'document'
       OR value->>'source_grade' IS DISTINCT FROM 'tier1'
       OR value->>'resolution_status' IS DISTINCT FROM 'resolved'
       OR coalesce(btrim(value->>'source_key'), '') = ''
       OR value->>'source_key' !~ '^kbo:ebook:[0-9a-z가-힣-]+$'
       OR coalesce(btrim(value->>'entity_id'), '') = ''
       OR coalesce(btrim(value->>'page_title'), '') = ''
       OR coalesce(btrim(value->>'canonical_url'), '') = ''
       OR coalesce(btrim(value->>'identity_fingerprint'), '') = ''
       OR CASE
            WHEN jsonb_typeof(value->'candidate_urls') = 'array'
            THEN jsonb_array_length(value->'candidate_urls') < 1
            ELSE true
          END
       OR jsonb_typeof(value->'metadata') IS DISTINCT FROM 'object'
  ) THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'invalid kbo ebook source payload';
  END IF;
  IF (
    SELECT count(DISTINCT value->>'source_key')
    FROM jsonb_array_elements(p_sources) AS item(value)
  ) <> v_expected THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'duplicate source_key in payload';
  END IF;

  INSERT INTO public.genius_rag_sources AS target (
    source_key, source_kind, entity_type, entity_id, page_title, candidate_urls,
    canonical_url, resolution_status, resolution_note, source_grade,
    identity_fingerprint, metadata
  )
  SELECT
    value->>'source_key', value->>'source_kind', value->>'entity_type', value->>'entity_id',
    value->>'page_title',
    ARRAY(SELECT jsonb_array_elements_text(value->'candidate_urls')),
    value->>'canonical_url', value->>'resolution_status', value->>'resolution_note',
    value->>'source_grade', value->>'identity_fingerprint', value->'metadata'
  FROM jsonb_array_elements(p_sources) AS item(value)
  ON CONFLICT (source_key) DO UPDATE SET
    source_kind = EXCLUDED.source_kind,
    entity_type = EXCLUDED.entity_type,
    entity_id = EXCLUDED.entity_id,
    page_title = EXCLUDED.page_title,
    candidate_urls = EXCLUDED.candidate_urls,
    canonical_url = EXCLUDED.canonical_url,
    resolution_status = EXCLUDED.resolution_status,
    resolution_note = EXCLUDED.resolution_note,
    source_grade = EXCLUDED.source_grade,
    identity_fingerprint = EXCLUDED.identity_fingerprint,
    metadata = (EXCLUDED.metadata - ARRAY['loaderRevision', 'pendingLoaderRevision'])
      || CASE WHEN target.metadata ? 'loaderRevision'
         THEN jsonb_build_object('loaderRevision', target.metadata->>'loaderRevision')
         ELSE '{}'::jsonb END
      || CASE WHEN target.metadata ? 'pendingLoaderRevision'
         THEN jsonb_build_object('pendingLoaderRevision', target.metadata->>'pendingLoaderRevision')
         ELSE '{}'::jsonb END,
    updated_at = now();

  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected <> v_expected THEN
    RAISE EXCEPTION USING errcode = 'P0001',
      message = format('source ensure count mismatch expected=%s actual=%s', v_expected, v_affected);
  END IF;
  RETURN v_affected;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_baseball_genius_ebook_sources(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_baseball_genius_ebook_sources(jsonb)
  TO service_role;

--
-- ⚠️ 인자 추가는 CREATE OR REPLACE 로 불가능하다(새 함수가 생기고 DEFAULT 때문에 ambiguous).
-- 기존 7-인자 시그니처를 명시 DROP 하고 8-인자로 재생성한다.
DROP FUNCTION IF EXISTS public.complete_baseball_genius_rag_source(
  text, uuid, bigint, text, text, timestamptz, timestamptz
);

-- ⚠️ CREATE OR REPLACE 여야 한다. 재적용 시 8-인자 함수가 이미 존재하면
-- 순수 CREATE 는 42723 으로 죽는다(내 첫 판이 실제로 Vercel prebuild 를 깼다).
-- 위 DROP 은 **구 7-인자** 시그니처만 지우므로, 새 시그니처는 REPLACE 로 멱등하게 둔다.
CREATE OR REPLACE FUNCTION public.complete_baseball_genius_rag_source(
  p_source_key text,
  p_claim_token uuid,
  p_claim_generation bigint,
  p_revision text,
  p_content_hash text,
  p_crawled_at timestamptz,
  p_stale_after timestamptz,
  p_expected_chunk_count integer DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_completed boolean;
BEGIN
  -- 기대 수를 주면 반드시 양수여야 한다. 0/음수를 허용하면 "빈 적재"가 성공이 된다.
  IF p_expected_chunk_count IS NOT NULL AND p_expected_chunk_count < 1 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'expected chunk count must be positive';
  END IF;

  UPDATE public.genius_rag_sources source
  SET ingestion_status = 'ready',
      ingestion_attempts = 0,
      active_claim_generation = p_claim_generation,
      revision = p_revision,
      content_hash = p_content_hash,
      crawled_at = p_crawled_at,
      ingested_at = clock_timestamp(),
      stale_after = p_stale_after,
      lease_until = NULL,
      claim_token = NULL,
      last_error = NULL,
      metadata = CASE
        WHEN source.metadata ? 'pendingLoaderRevision' THEN
          (source.metadata - 'pendingLoaderRevision')
          || jsonb_build_object('loaderRevision', source.metadata->>'pendingLoaderRevision')
        ELSE source.metadata
      END,
      updated_at = now()
  WHERE source.source_key = p_source_key
    AND source.ingestion_status = 'ingesting'
    AND source.claim_token = p_claim_token
    AND source.claim_generation = p_claim_generation
    AND source.lease_until > clock_timestamp()
    -- source-level provenance는 실제 anchor chunk에 결속한다.
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
    -- 다문서 revision/hash/crawled_at 차이는 의도된 provenance다. claim/embedding 오염만 거부한다.
    AND NOT EXISTS (
      SELECT 1 FROM public.genius_rag_chunks chunk
      WHERE chunk.source_key = source.source_key
        AND chunk.claim_generation = p_claim_generation
        AND (
          chunk.embedding IS NULL
          OR chunk.claim_token IS DISTINCT FROM p_claim_token
        )
    )
    -- ▼ 적재량 계약: staged chunk 수가 기대와 다르면 swap 자체를 하지 않는다.
    --   불일치 시 UPDATE 0행 → active 유지 + 아래 DELETE 미실행 → last-good 보존.
    AND (
      p_expected_chunk_count IS NULL
      OR (
        SELECT count(*) FROM public.genius_rag_chunks chunk
        WHERE chunk.source_key = source.source_key
          AND chunk.claim_generation = p_claim_generation
      ) = p_expected_chunk_count
    )
  RETURNING true INTO v_completed;

  IF coalesce(v_completed, false) THEN
    DELETE FROM public.genius_rag_chunks chunk
    WHERE chunk.source_key = p_source_key
      AND chunk.claim_generation <> p_claim_generation;
  END IF;

  RETURN coalesce(v_completed, false);
END;
$$;

REVOKE ALL ON FUNCTION public.complete_baseball_genius_rag_source(
  text, uuid, bigint, text, text, timestamptz, timestamptz, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_baseball_genius_rag_source(
  text, uuid, bigint, text, text, timestamptz, timestamptz, integer
) TO service_role;

-- ── 재적재 경로 ──────────────────────────────────────────────────────────────
-- 사고(삼순 R4 #1050-1): 운영 source 10건이 이미 `ready` 라서 scoped claim
-- (`not_started|stale|failed` 만 대상)이 0건을 반환한다. 수정된 로더로 재적재하려 해도
-- claim 0 → exit 1 이고, `--reset-state` 는 로컬 체크포인트만 지워 DB 상태를 못 바꾼다.
--
-- 준비된 revision 이 현재 active 와 다를 때만 `stale` 로 내려 claim 가능하게 만든다.
-- **active_claim_generation 은 건드리지 않는다** → 기존 snapshot 은 계속 서빙된다.
DROP FUNCTION IF EXISTS public.request_baseball_genius_rag_refresh(text, text);

CREATE OR REPLACE FUNCTION public.request_baseball_genius_rag_refresh(
  p_source_key text,
  p_revision text,
  p_loader_revision text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_marked boolean;
BEGIN
  IF p_source_key IS NULL OR p_revision IS NULL OR btrim(p_revision) = ''
     OR p_loader_revision IS NULL OR btrim(p_loader_revision) = '' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'source key, revision and loader revision are required';
  END IF;

  UPDATE public.genius_rag_sources source
  SET ingestion_status = 'stale',
      ingestion_attempts = 0,   -- 재적재는 새 시도다. 과거 실패 예산을 물려받지 않는다.
      lease_until = NULL,
      claim_token = NULL,
      metadata = jsonb_set(source.metadata, '{pendingLoaderRevision}', to_jsonb(p_loader_revision), true),
      updated_at = now()
  WHERE source.source_key = p_source_key
    AND source.tombstoned_at IS NULL
    AND source.ingestion_status = 'ready'
    -- 원문 revision이 같아도 청킹/파서 계약이 바뀌면 1회 재적재한다.
    -- complete가 pendingLoaderRevision을 loaderRevision으로 승격한 뒤에는 다시 no-op이다.
    AND (
      source.revision IS DISTINCT FROM p_revision
      OR source.metadata->>'loaderRevision' IS DISTINCT FROM p_loader_revision
    )
  RETURNING true INTO v_marked;

  RETURN coalesce(v_marked, false);
END;
$$;

REVOKE ALL ON FUNCTION public.request_baseball_genius_rag_refresh(text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_baseball_genius_rag_refresh(text, text, text)
  TO service_role;
