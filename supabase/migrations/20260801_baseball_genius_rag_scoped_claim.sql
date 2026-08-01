-- 야잘알봇 v2 S2b: **대상 범위를 claim 이전에 좁히는** RPC를 추가한다.
--
-- 왜 필요한가 (삼순 R1 P0 #3): 기존 claim_baseball_genius_rag_batch는 resolved인 모든
-- namu_document를 잡는다. 슬라이스 worker는 claim을 *받은 뒤에* 대상 밖 source를
-- fail(out_of_s2b_slice_scope)로 반납했는데, fail RPC는 ingestion_attempts를 올린다.
-- 그래서 `rag:ingest`를 3번만 돌리면 대상 밖 운영 source(KBO 리그 + 10구단)가
-- ingestion_attempts=3 / ingestion_status='failed'로 **retry 예산이 영구 소진**되어
-- 이후 어떤 워커도 그 source를 다시 claim할 수 없게 된다(PGlite 재현 완료).
--
-- 해결: 범위 필터를 DB 경계 안(claim 술어)으로 옮긴다. 대상 밖 source는 애초에 claim되지
-- 않으므로 lease도 attempts도 건드리지 않는다 = **scope skip은 retry 예산 0 소비**.
--
-- 기존 2-arg 함수는 그대로 둔다(시그니처 변경 아님, 별도 이름의 새 함수). 전수 확대 단계에서
-- 범위 인자 없이 도는 배치를 계속 쓸 수 있고, 이번 변경이 기존 계약/권한/회귀를 건드리지 않는다.
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
    WHERE source.source_kind = 'namu_document'
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

REVOKE ALL ON FUNCTION public.claim_baseball_genius_rag_batch_scoped(integer, integer, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_baseball_genius_rag_batch_scoped(integer, integer, text[])
  TO service_role;
