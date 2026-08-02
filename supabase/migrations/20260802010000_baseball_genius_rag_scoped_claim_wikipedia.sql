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
    -- ▼ 문서형 소스 전체가 후보. 여기가 좁아지면 그 종류가 통째로 죽는다.
    --   ⚠️ 이 파일은 사전순 뒤쪽이라 앞선 migration 의 확장을 **덮어쓴다**.
    --   그래서 아직 이 브랜치에 없는 종류(kbo_ebook, #1050)까지 미리 포함한다.
    --   IN 목록의 값은 CHECK 제약과 무관하므로, 해당 종류가 없는 DB 에서도 안전하다.
    --   (이 규칙을 어겨서 wikipedia 가 죽은 것이 삼순 R4 P0-1 사고다 — 같은 실수 반복 금지)
    WHERE source.source_kind IN ('namu_document', 'wikipedia_document', 'kbo_ebook')
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
  ),
  purged AS (
    DELETE FROM public.genius_rag_chunks chunk
    USING claimed
    WHERE chunk.source_key = claimed.source_key
      AND chunk.claim_generation < claimed.claim_generation
      AND chunk.claim_generation <> claimed.active_claim_generation
    RETURNING chunk.id
  )
  SELECT * FROM claimed;
END;
$$;

-- 하위문서 chunk는 root source와 entity/page ownership을 공유하지만 canonical provenance는
-- 실제 하위문서 URL이어야 한다. root canonical의 exact `root/…` 하위 prefix와 metadata의
-- exact 일치를 함께 검증해 호출자가 다른 선수 canonical을 같은 claim에 귀속시키지 못하게 한다.
CREATE OR REPLACE FUNCTION public.validate_baseball_genius_rag_chunk_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_source public.genius_rag_sources%ROWTYPE;
  v_root_path text;
  v_chunk_path text;
BEGIN
  SELECT * INTO v_source
  FROM public.genius_rag_sources
  WHERE source_key = NEW.source_key
  FOR SHARE;

  -- PostgreSQL core에는 범용 URL parser가 없다. 이 provenance 계약은 Namu canonical의
  -- 허용 scheme/host/path를 먼저 분리하고, URL parser가 path로 접는 구분자·dot segment를
  -- fail-close한 뒤에만 root/child 결속을 검사한다. raw URL prefix만 비교하면
  -- `/문보경/../김도영`이 브라우저에서 `/김도영`으로 정규화되는 우회가 열린다.
  v_root_path := substring(v_source.canonical_url FROM '^https://namu[.]wiki(/w/[^?#]+)$');
  v_chunk_path := substring(NEW.canonical_url FROM '^https://namu[.]wiki(/w/[^?#]+)$');

  IF v_source.source_key IS NULL
    OR v_source.source_kind NOT IN ('namu_document', 'wikipedia_document', 'kbo_ebook')
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
    OR (
      v_source.canonical_url <> NEW.canonical_url
      AND NOT (
        v_source.source_kind = 'namu_document'
        AND v_root_path IS NOT NULL
        AND v_chunk_path IS NOT NULL
        -- WHATWG URL parser는 raw TAB/CR/LF를 parsing 전에 제거한다. DB가 이를
        -- path 문자로 비교하면 `root/\t../other`를 child로 오인하므로 raw 공백·제어문자는 거부.
        AND v_source.canonical_url !~ '[[:space:][:cntrl:]]'
        AND NEW.canonical_url !~ '[[:space:][:cntrl:]]'
        AND position(E'\\' IN v_root_path) = 0
        AND position(E'\\' IN v_chunk_path) = 0
        AND v_root_path !~ '(^|/)[.]{1,2}(/|$)'
        AND v_chunk_path !~ '(^|/)[.]{1,2}(/|$)'
        -- encoded dot/separator와 double-encoding(%25)은 decode 횟수에 관계없이 거부.
        AND v_root_path !~* '%(2e|2f|5c|25)'
        AND v_chunk_path !~* '%(2e|2f|5c|25)'
        AND left(v_chunk_path, length(v_root_path) + 1) = v_root_path || '/'
        AND NEW.metadata ->> 'documentCanonicalUrl' = NEW.canonical_url
      )
    )
    OR v_source.source_grade <> NEW.source_grade
  THEN
    RAISE EXCEPTION 'stale or mismatched rag chunk owner/provenance';
  END IF;
  NEW.source_kind := v_source.source_kind;
  RETURN NEW;
END;
$$;

-- resolution의 canonical/status도 identity fingerprint에 포함된다. ready source가 missing/blocked
-- 로 재판정되면 이 trigger가 마지막 성공 snapshot과 진행 중 claim을 같은 UPDATE에서 무효화한다.
-- 그렇지 않으면 ready provenance CHECK가 UPDATE를 거부하고 옛 active snapshot이 계속 서빙된다.
CREATE OR REPLACE FUNCTION public.invalidate_baseball_genius_rag_identity_drift()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.identity_fingerprint IS DISTINCT FROM NEW.identity_fingerprint THEN
    DELETE FROM public.genius_rag_chunks WHERE source_key = OLD.source_key;
    NEW.ingestion_status := 'not_started';
    NEW.ingestion_attempts := 0;
    NEW.lease_until := NULL;
    NEW.claim_token := NULL;
    NEW.active_claim_generation := 0;
    NEW.revision := NULL;
    NEW.content_hash := NULL;
    NEW.crawled_at := NULL;
    NEW.ingested_at := NULL;
    NEW.stale_after := NULL;
    NEW.last_error := NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_baseball_genius_rag_batch_scoped(integer, integer, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_baseball_genius_rag_batch_scoped(integer, integer, text[])
  TO service_role;
