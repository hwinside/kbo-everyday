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
--
-- ⚠️ 인자 추가는 CREATE OR REPLACE 로 불가능하다(새 함수가 생기고 DEFAULT 때문에 ambiguous).
-- 기존 7-인자 시그니처를 명시 DROP 하고 8-인자로 재생성한다.
DROP FUNCTION IF EXISTS public.complete_baseball_genius_rag_source(
  text, uuid, bigint, text, text, timestamptz, timestamptz
);

CREATE FUNCTION public.complete_baseball_genius_rag_source(
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
CREATE OR REPLACE FUNCTION public.request_baseball_genius_rag_refresh(
  p_source_key text,
  p_revision text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_marked boolean;
BEGIN
  IF p_source_key IS NULL OR p_revision IS NULL OR btrim(p_revision) = '' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'source key and revision are required';
  END IF;

  UPDATE public.genius_rag_sources source
  SET ingestion_status = 'stale',
      ingestion_attempts = 0,   -- 재적재는 새 시도다. 과거 실패 예산을 물려받지 않는다.
      lease_until = NULL,
      claim_token = NULL,
      updated_at = now()
  WHERE source.source_key = p_source_key
    AND source.tombstoned_at IS NULL
    AND source.ingestion_status = 'ready'
    -- 같은 revision 을 다시 밀어 넣는 것은 재적재가 아니다(무한 재적재 방지).
    AND source.revision IS DISTINCT FROM p_revision
  RETURNING true INTO v_marked;

  RETURN coalesce(v_marked, false);
END;
$$;

REVOKE ALL ON FUNCTION public.request_baseball_genius_rag_refresh(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_baseball_genius_rag_refresh(text, text)
  TO service_role;
