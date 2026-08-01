-- 야잘알봇 v2 S2b: scoped claim 이 Wikipedia source 를 다시 받도록 복구한다.
--
-- 사고(삼순 R4 P0-1): migration 은 **파일명 사전순**으로 적용된다. 실측 순서는
--   20260801220000_..._wikipedia_source.sql        (scoped 를 2종으로 확장)
--   20260801223000_..._multidocument_snapshot.sql
--   20260801_baseball_genius_rag_scoped_claim.sql  (scoped 를 namu 전용으로 재정의)
-- 마지막 파일이 `_`(0x5F) > `2`(0x32) 라서 **가장 뒤**에 온다. 그래서 wikipedia
-- migration 이 확장해둔 `claim_baseball_genius_rag_batch_scoped` 를 원본(namu 전용)이
-- 덮어써서 `wikipedia:*` source 가 영영 claim 되지 않는다.
--
-- 제출 smoke 는 `scoped → wikipedia` 순으로 수동 적용해 이 결손을 건너뛰었다(false-green).
--
-- 여기서는 파일명을 바꾸지 않는다(이미 적용된 환경에서 파일명을 바꾸면 재적용/누락 위험).
-- 대신 **사전순으로 확실히 마지막**인 이 파일에서 2종 허용본으로 확정한다.
-- 본문은 wikipedia migration 의 scoped 정의와 동일하며 `source_kind` 조건만 폐쇄집합이다.
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
  IF cardinality(p_source_keys) > 1000 THEN
    RAISE EXCEPTION 'rag claim scope too large';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT source.source_key AS source_key
    FROM public.genius_rag_sources source
    -- ▼ 문서형 소스 2종 모두 후보. 여기가 namu 전용으로 좁아지면 wikipedia 가 죽는다.
    WHERE source.source_kind IN ('namu_document', 'wikipedia_document')
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
    FROM candidates
    WHERE source.source_key = candidates.source_key
    RETURNING source.*
  )
  SELECT * FROM claimed;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_baseball_genius_rag_batch_scoped(integer, integer, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_baseball_genius_rag_batch_scoped(integer, integer, text[])
  TO service_role;
