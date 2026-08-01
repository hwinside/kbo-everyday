-- 야잘알봇 v2 — KBO **공식 e북(PDF) 코퍼스**를 RAG 소스로 받는다 (tier1 문서형).
-- 운영 DB 직접 적용 금지: PR 리뷰·머지·배포 게이트 뒤 적용한다. 이 파일은 초안이다.
--
-- 배경 (실측, 2026-08-01):
--   - 운영 DB에는 20260731 bootstrap만 적용돼 있다. `claim_baseball_genius_rag_batch_scoped`가
--     존재하지 않고 `genius_rag_sources_source_kind_check`가 아직
--     ('kbo_structured','namu_document')이다 → PR #1044의 wikipedia/multidoc 마이그레이션은 **미적용**.
--     그래서 이 파일은 #1044 적용 여부와 무관하게 성립하도록 **자족적·멱등**으로 작성한다.
--   - 수집된 코퍼스: KBO 공식 e북 10종 3,710페이지 / 693만자 (2종은 텍스트 레이어 없음 → 제외).
--
-- 왜 새 종류가 필요한가:
--   `kbo_structured`는 KBO 기록실 **화면 크롤(structured retrieval)** 용이고
--   (`metadata.embeddingAllowed=false`, `retrievalMode=structured`), chunk를 만들지 않는다.
--   공식 e북은 **문서형 tier1**이라 기존 두 종류 어디에도 맞지 않는다:
--     - `namu_document`/`wikipedia_document` → tier2 강제 (수치 확정 불가) ⇒ 규약·규칙·기록 정본을 tier2로
--       올리면 §12 수치 계약상 숫자를 못 쓴다. 공식 문서를 tier2로 등록하는 것은 계약 왜곡이다.
--     - `kbo_structured` → chunk 테이블 FK/CHECK가 문서형을 전제하지 않는다.
--   ⇒ `kbo_ebook`(tier1 문서형)을 새로 연다.
--
-- 이 마이그레이션이 하는 일 (기존 행은 한 건도 건드리지 않는다 — CHECK/술어 확장 + RPC 1건 추가):
--   1) sources.source_kind 폐쇄집합에 'kbo_ebook' 추가
--   2) tier 매핑 CHECK: kbo_ebook → tier1
--   3) sources/chunks.entity_type 폐쇄집합에 'document' 추가
--   4) ready provenance CHECK: 문서형 소스 집합에 kbo_ebook 포함
--   5) chunks.source_kind CHECK 확장, chunks.source_grade CHECK를 tier1까지 확장
--   6) chunk owner trigger: 허용 kind 확장 + chunk.source_kind를 **소스에서 파생**(FK 보호)
--   7) claim RPC(전역/scoped): 후보 kind 확장
--   8) [신규] lease heartbeat RPC — 아래 §주의 참조

-- ─────────────────────────────────────────────────────────────────────────────
-- §주의 1 — 왜 heartbeat RPC를 새로 추가하는가 (계약 변경이므로 리뷰 필요)
--   claim RPC의 lease 상한은 1800초다. 그런데 e북 1권은 chunk가 수천 건이고
--   Gemini batchEmbedContents 실측이 16건/5.5초이므로 최대 문서(2015 기록대백과 3.36M자,
--   약 5,000 chunk)는 임베딩만 ~29분이 필요하다 = 상한과 같거나 초과한다.
--   lease가 만료되면 owner trigger가 `lease_until <= clock_timestamp()`로 이후 chunk를 전부 거부하고,
--   그 generation은 complete에 도달하지 못한다(적재 불가).
--   대안 두 가지 중 이 초안은 (b)를 택했다:
--     (a) e북을 페이지 구간 단위 여러 source로 쪼갠다 — 스키마 변경 0, 대신 source_key가 인위적으로
--         잘리고 "문서 1건 = source 1건" 모델이 깨진다.
--     (b) exact claim(token+generation)에 한해 lease만 연장하는 RPC를 추가한다 — 상태/attempts/
--         generation/active snapshot을 일절 건드리지 않으므로 §12 계약에 영향이 없다.
--   (b)는 남의 claim을 연장할 수 없고(토큰 불일치 시 no-op), 이미 만료된 lease는 연장하지 않는다
--   (만료 후 연장을 허용하면 다른 worker가 reclaim한 뒤에도 옛 worker가 살아나 이중 write가 된다).
--
-- §주의 2 — tier1 문서형이 서빙되려면 **앱 코드 변경이 별도로 필요하다**(이 마이그레이션 밖).
--   - `src/lib/baseball-qa/rag/retrieve.ts` `selectEvidence()`는
--     `if (canGroundNumericClaim(row.sourceGrade)) continue;` 로 **tier1 행을 버린다**.
--     그대로 두면 kbo_ebook chunk는 검색돼도 근거로 채택되지 않는다.
--   - 같은 파일 `validateRagResponse()`는 답변에 숫자가 있으면 무조건 폐기한다. 규약/규칙/기록 정본은
--     숫자가 본질이므로 tier 인지 게이트가 필요하다.
--   - `src/lib/baseball-qa/rag/contracts.ts`의 `RagSourceKind` 유니온과 `SOURCE_GRADE_BY_KIND`에
--     'wikipedia_document'와 'kbo_ebook'이 없다.
--   이 마이그레이션만 적용하면 **적재는 되지만 서빙은 되지 않는다**. 순서를 분리해 기록한다.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) sources.source_kind 폐쇄집합 확장 ---------------------------------------
ALTER TABLE public.genius_rag_sources
  DROP CONSTRAINT IF EXISTS genius_rag_sources_source_kind_check;
ALTER TABLE public.genius_rag_sources
  ADD CONSTRAINT genius_rag_sources_source_kind_check
  CHECK (source_kind IN ('kbo_structured', 'namu_document', 'wikipedia_document', 'kbo_ebook'));

-- 원본 테이블의 인라인 CHECK(tier 매핑 / ready provenance)은 **자동 생성 이름**이다
-- (운영 실측: `genius_rag_sources_check`, `genius_rag_sources_check2`). 이름을 하드코딩하면 환경마다
-- 번호가 달라 조용히 안 지워진다. #1044와 동일하게 **정의로 찾아 지운다**.
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
      AND pg_get_constraintdef(oid) NOT LIKE '%kbo_ebook%'
  LOOP
    EXECUTE format('ALTER TABLE public.genius_rag_sources DROP CONSTRAINT %I', v_name);
  END LOOP;
END;
$$;

-- 2) tier 매핑: 공식 e북은 tier1이다(1차 출처). 위키류는 그대로 tier2.
ALTER TABLE public.genius_rag_sources
  DROP CONSTRAINT IF EXISTS genius_rag_sources_grade_by_kind_check;
ALTER TABLE public.genius_rag_sources
  ADD CONSTRAINT genius_rag_sources_grade_by_kind_check
  CHECK (
    (source_kind IN ('kbo_structured', 'kbo_ebook') AND source_grade = 'tier1')
    OR (source_kind IN ('namu_document', 'wikipedia_document') AND source_grade = 'tier2')
  );

-- 3) entity_type 폐쇄집합 확장 — e북은 선수/팀/리그가 아니라 **문서 그 자체**가 entity다.
--    (league로 우겨넣으면 UNIQUE(source_kind, entity_type, entity_id)와 무관하게 의미가 오염되고,
--     리그 entity 기준 retrieval 필터가 규칙집 chunk를 리그 문서로 착각한다.)
ALTER TABLE public.genius_rag_sources
  DROP CONSTRAINT IF EXISTS genius_rag_sources_entity_type_check;
ALTER TABLE public.genius_rag_sources
  ADD CONSTRAINT genius_rag_sources_entity_type_check
  CHECK (entity_type IN ('record_category', 'league', 'team', 'player', 'document'));

-- 4) ready provenance CHECK: 문서형 소스 집합에 kbo_ebook 포함 -----------------
ALTER TABLE public.genius_rag_sources
  DROP CONSTRAINT IF EXISTS genius_rag_sources_ready_provenance_check;
ALTER TABLE public.genius_rag_sources
  ADD CONSTRAINT genius_rag_sources_ready_provenance_check
  CHECK (
    ingestion_status IS DISTINCT FROM 'ready'
    OR (
      source_kind IN ('namu_document', 'wikipedia_document', 'kbo_ebook')
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

-- 5) chunks CHECK 확장 --------------------------------------------------------
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
      AND pg_get_constraintdef(oid) NOT LIKE '%kbo_ebook%'
  LOOP
    EXECUTE format('ALTER TABLE public.genius_rag_chunks DROP CONSTRAINT %I', v_name);
  END LOOP;
END;
$$;
ALTER TABLE public.genius_rag_chunks
  DROP CONSTRAINT IF EXISTS genius_rag_chunks_source_kind_check;
ALTER TABLE public.genius_rag_chunks
  ADD CONSTRAINT genius_rag_chunks_source_kind_check
  CHECK (source_kind IN ('namu_document', 'wikipedia_document', 'kbo_ebook'));

-- source_grade: 지금까지 chunk는 tier2 전용이었다(`CHECK (source_grade = 'tier2')`).
-- tier1 문서형이 생겼으므로 폐쇄집합으로 넓힌다. **tier1이 되는 경로는 kbo_ebook뿐**임을
-- 소스 쪽 tier 매핑 CHECK + owner trigger의 `source_grade` 대조가 이중으로 보장한다.
ALTER TABLE public.genius_rag_chunks
  DROP CONSTRAINT IF EXISTS genius_rag_chunks_source_grade_check;
ALTER TABLE public.genius_rag_chunks
  ADD CONSTRAINT genius_rag_chunks_source_grade_check
  CHECK (source_grade IN ('tier1', 'tier2'));

ALTER TABLE public.genius_rag_chunks
  DROP CONSTRAINT IF EXISTS genius_rag_chunks_entity_type_check;
ALTER TABLE public.genius_rag_chunks
  ADD CONSTRAINT genius_rag_chunks_entity_type_check
  CHECK (entity_type IN ('league', 'team', 'player', 'document'));

-- 6) ingestion 큐 인덱스 — 문서형 소스 전체 -----------------------------------
DROP INDEX IF EXISTS public.idx_genius_rag_sources_ingestion_queue;
CREATE INDEX IF NOT EXISTS idx_genius_rag_sources_ingestion_queue
  ON public.genius_rag_sources (
    question_count DESC,
    last_question_at DESC NULLS LAST,
    source_key
  )
  WHERE source_kind IN ('namu_document', 'wikipedia_document', 'kbo_ebook')
    AND resolution_status = 'resolved'
    AND canonical_url IS NOT NULL
    AND ingestion_attempts < 3
    AND ingestion_status IN ('not_started', 'failed', 'stale', 'ingesting');

-- 7) chunk owner trigger — 허용 kind 확장 + source_kind 파생 --------------------
-- `chunks.source_kind`의 컬럼 기본값은 'namu_document'다. upsert RPC는 이 컬럼을 넘기지 않으므로
-- kbo_ebook 소스의 chunk가 기본값으로 들어가면 FK(source_key, source_kind)가 깨진다.
-- 귀속은 호출자가 아니라 **소스 행**이 정한다.
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
    OR v_source.canonical_url <> NEW.canonical_url
    OR v_source.source_grade <> NEW.source_grade
  THEN
    RAISE EXCEPTION 'stale or mismatched rag chunk owner/provenance';
  END IF;
  NEW.source_kind := v_source.source_kind;
  RETURN NEW;
END;
$$;

-- 8) claim RPC — 후보 kind 확장 (술어 한 줄 외 계약 동일) ----------------------
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
    WHERE source.source_kind IN ('namu_document', 'wikipedia_document', 'kbo_ebook')
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
    FROM candidates candidate
    WHERE source.source_key = candidate.source_key
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
  SELECT claimed.* FROM claimed;
END;
$$;

-- 9) [신규] lease heartbeat — §주의 1 참조 -------------------------------------
-- exact claim(token + generation)에 대해서만, 아직 만료되지 않은 lease를 연장한다.
-- 상태·attempts·generation·active snapshot·provenance는 일절 건드리지 않는다.
CREATE OR REPLACE FUNCTION public.heartbeat_baseball_genius_rag_lease(
  p_source_key text,
  p_claim_token uuid,
  p_claim_generation bigint,
  p_lease_seconds integer DEFAULT 300
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF p_lease_seconds < 30 OR p_lease_seconds > 1800 THEN
    RAISE EXCEPTION 'invalid rag lease bounds';
  END IF;

  UPDATE public.genius_rag_sources source
  SET lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  WHERE source.source_key = p_source_key
    AND source.ingestion_status = 'ingesting'
    AND source.claim_token = p_claim_token
    AND source.claim_generation = p_claim_generation
    -- 이미 만료된 lease는 되살리지 않는다. 만료 뒤 다른 worker가 reclaim했을 수 있고,
    -- 그 경우 옛 worker가 부활하면 같은 source에 두 worker가 쓰게 된다.
    AND source.lease_until > clock_timestamp()
  RETURNING true INTO v_ok;

  RETURN coalesce(v_ok, false);
END;
$$;

REVOKE ALL ON FUNCTION public.heartbeat_baseball_genius_rag_lease(text, uuid, bigint, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_baseball_genius_rag_lease(text, uuid, bigint, integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.claim_baseball_genius_rag_batch_scoped(integer, integer, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_baseball_genius_rag_batch_scoped(integer, integer, text[])
  TO service_role;
