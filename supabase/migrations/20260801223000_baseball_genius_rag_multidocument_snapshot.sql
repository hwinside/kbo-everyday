-- R4: 나무위키 메인+하위문서 corpus를 한 generation에 원자적으로 complete한다.
--
-- 기존 함수는 한 generation의 모든 chunk가 동일 revision/document_content_hash/crawled_at일 것을
-- 요구했다(단일 문서 snapshot). 하위문서는 각각 독립 canonical/revision/content hash를 가지므로 이
-- 조건으로는 올바른 다문서 corpus도 COMPLETE_REJECTED가 된다.
--
-- 변경 계약:
--   1. source row의 revision/content_hash/crawled_at은 generation의 anchor chunk 1건과 일치해야 한다.
--   2. 같은 generation의 모든 chunk는 embedding·claim token이 유효해야 한다.
--   3. 각 chunk의 document provenance는 서로 달라도 된다(section_path로 문서를 추적).
-- active generation swap과 이전 snapshot 보존/정리는 기존 계약 그대로다.

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
  text, uuid, bigint, text, text, timestamptz, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_baseball_genius_rag_source(
  text, uuid, bigint, text, text, timestamptz, timestamptz
) TO service_role;
