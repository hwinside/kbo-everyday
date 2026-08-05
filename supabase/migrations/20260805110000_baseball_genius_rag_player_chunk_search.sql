-- 야잘알봇: 선수(tier2) chunk 후보 선정을 **DB 벡터 정렬**로 바꾼다.
--
-- 왜 필요한가 (production 실측 사고)
--   `문보경 별명이 뭐야?` → "만루바보"만 답하고 가장 유명한 "문보물"을 언급조차 못 했다.
--   원인은 우선순위(위키 > 나무위키)가 아니라 **후보 선정 단계**였다:
--     · 문보경 나무위키 chunk = 133건
--     · 앱은 `.eq(...).limit(40)` 으로 **정렬 없이 앞 40건**만 가져왔다
--     · '문보물'은 chunk_index 51 → 애초에 후보에 못 들어옴 → 코사인 계산 대상조차 아님
--     · '별명' 언급 chunk 는 41·51·61·81·119 인데 그중 41 하나만 후보에 걸렸다
--   즉 유사도 정렬을 앱에서 아무리 잘 해도, DB가 이미 엉뚱한 40건을 잘라 보냈다.
--   우선순위를 뒤집어도 같은 40건 안에서만 재정렬되므로 답이 바뀌지 않는다(실측 확인).
--
-- 계약 (공식 문서 RPC `search_baseball_genius_official_chunks` 와 동일한 원칙)
--   1. 서빙 뷰(genius_rag_serving_chunks)만 읽는다 — active generation 만 노출되므로
--      수집 중인 미완성 snapshot 이 검색에 새지 않는다.
--   2. entity_type/entity_id/source_kind 를 **함수 안에서** 등가 필터로 강제한다.
--      호출자가 우회해 남의 선수 chunk 를 후보에 넣을 수 없다.
--   3. source_kind 는 tier2 폐쇄집합(`namu_document`,`wikipedia_document`)만 허용한다.
--      tier1(공식 간행물)이 이 경로로 새면 "tier1 근거일 때만 숫자 허용" 계약이 깨진다.
--      허용 밖 값은 조용한 0행이 아니라 **예외**로 드러낸다.
--   4. p_limit 은 1..50 으로 clamp — 상한 없는 정렬 조회는 query-guard 위반이다.
--   5. embedding 을 **반환한다**. 공식 문서 RPC 와 다른 점이며 의도적이다:
--      tier2 경로는 앱이 `rankEvidenceByQuery` 에 질문 의도별 가중(`tier2WeightForQuestion`)을
--      곱해 최종 정렬을 하므로 벡터가 필요하다. (전역 소스 hard sort `orderTier2Evidence` 는
--      삼순 P0 로 폐기됐다 — 순서 강제는 더 가까운 반대편 근거를 통째로 탈락시켰다.)
--      DB 는 "올바른 후보 40건"을 고르는 역할만 맡고
--      최종 근거 4건 선택은 기존 앱 계약을 그대로 둔다(변경 최소화).
--      행 수는 종전과 동일(source_kind 당 최대 40)이라 응답 크기 회귀가 없다.
--
-- 멱등: CREATE INDEX IF NOT EXISTS + CREATE OR REPLACE FUNCTION.

-- 1) 조회 술어용 부분 인덱스 ----------------------------------------------------
-- 벡터 인덱스(idx_genius_rag_chunks_embedding_hnsw)는 공식 문서 migration 에서 이미 만들었고
-- 여기서는 entity 등가 필터가 먼저 좁혀지도록 복합 인덱스를 둔다.
CREATE INDEX IF NOT EXISTS idx_genius_rag_chunks_entity_lookup
  ON public.genius_rag_chunks (entity_type, entity_id, source_kind, claim_generation);

-- 2) 검색 RPC ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_baseball_genius_player_chunks(
  p_entity_type text,
  p_entity_id text,
  p_source_kind text,
  p_query_embedding text,
  p_limit integer DEFAULT 40
)
RETURNS TABLE (
  content text,
  page_title text,
  canonical_url text,
  revision text,
  section_path text,
  as_of date,
  source_grade text,
  source_kind text,
  embedding text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 40), 1), 50);
  v_vec extensions.vector(768);
BEGIN
  -- tier2 폐쇄집합 밖은 조용히 0행으로 넘기지 않는다. 0행은 "미수집 선수"와 구분되지 않아
  -- 배선 실수가 fail-close 로 위장된다.
  IF p_source_kind IS NULL OR p_source_kind NOT IN ('namu_document', 'wikipedia_document') THEN
    RAISE EXCEPTION 'unsupported source_kind: %', p_source_kind;
  END IF;

  -- entity_type 도 같은 이유로 폐쇄집합이다. 이 RPC 는 선수 tier2 경로 전용이라
  -- 'document'(tier1 공식간행물)나 오타가 들어오면 조용히 0행이 아니라 드러나야 한다.
  IF p_entity_type IS DISTINCT FROM 'player' THEN
    RAISE EXCEPTION 'unsupported entity_type: %', p_entity_type;
  END IF;

  IF p_entity_id IS NULL OR btrim(p_entity_id) = '' THEN
    RAISE EXCEPTION 'entity_id is required';
  END IF;

  -- 잘못된 벡터 문자열도 즉시 예외로 드러낸다(조용한 0행 = 근거없음 오인).
  IF p_query_embedding IS NULL THEN
    RAISE EXCEPTION 'query embedding is required';
  END IF;
  v_vec := p_query_embedding::extensions.vector(768);

  -- 영벡터는 코사인 거리가 정의되지 않아 정렬이 무의미해진다(임베딩 실패를
  -- 조용히 "아무 40건"으로 바꾸는 경로라 fail-close 한다).
  -- 자기 자신과의 코사인 거리는 정상 벡터면 0, 영벡터면 NaN 이다.
  -- (`l2_norm` 은 vector/halfvec/sparsevec 오버로드가 있어 text 입력에서 모호해진다.)
  IF (v_vec OPERATOR(extensions.<=>) v_vec) <> 0 THEN
    RAISE EXCEPTION 'query embedding must be non-zero';
  END IF;

  RETURN QUERY
  SELECT
    chunk.content,
    chunk.page_title,
    chunk.canonical_url,
    chunk.revision,
    chunk.section_path,
    chunk.as_of,
    chunk.source_grade,
    chunk.source_kind,
    chunk.embedding::text
  FROM public.genius_rag_serving_chunks chunk
  WHERE chunk.entity_type = p_entity_type
    AND chunk.entity_id = p_entity_id
    AND chunk.source_kind = p_source_kind
  ORDER BY chunk.embedding <=> v_vec
  LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.search_baseball_genius_player_chunks(text, text, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_baseball_genius_player_chunks(text, text, text, text, integer)
  TO service_role;

COMMENT ON FUNCTION public.search_baseball_genius_player_chunks(text, text, text, text, integer) IS
  '선수(tier2) chunk 벡터 검색. 서빙 뷰만 읽고 entity/source_kind 를 함수 안에서 강제하며 상한 50으로 clamp 한다. 앱 최종 정렬을 위해 embedding 을 함께 반환한다.';
