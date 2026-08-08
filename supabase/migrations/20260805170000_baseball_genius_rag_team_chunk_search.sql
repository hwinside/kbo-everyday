-- 야잘알봇: 구단(team) tier2 chunk 를 **조회 가능하게** 연다.
--
-- 왜 필요한가 (production 실측, 2026-08-05)
--   `genius_rag_serving_chunks` 에 `entity_type='team'` chunk 가 **71,531건** 적재되어 있다
--   (10개 구단 전부, 전량 `namu_document`/`tier2`):
--     LG 14,903 · 롯데 9,188 · 삼성 9,246 · 한화 8,520 · KIA 8,054
--     두산 6,716 · NC 5,270 · kt 4,134 · 키움 2,931 · SSG 2,569
--   그런데 조회 RPC 가 `IF p_entity_type IS DISTINCT FROM 'player' THEN RAISE EXCEPTION`
--   으로 닫혀 있어서, 앱이 team 후보를 만들어 넘겨도 DB 에서 즉시 예외로 죽는다.
--   즉 **적재는 끝났는데 서빙 경로가 물리적으로 닫혀 있었다**. 실제 유저 질문
--   `LG 트윈스 역사 알려줘` 는 `source=llm` 으로 떨어졌고(=RAG 미경유), 답이 그럴듯했던 건
--   모델이 원래 알던 지식일 뿐 우리 corpus 를 읽은 결과가 아니었다.
--
-- 무엇을 바꾸는가 (최소 변경)
--   entity_type 폐쇄집합을 `'player'` → `('player','team')` 로 **한 칸만** 넓힌다.
--   그 외 계약은 전부 그대로다:
--     · 서빙 뷰만 읽는다(active generation 만 노출 — 수집 중 snapshot 누출 없음)
--     · entity_type/entity_id/source_kind 를 함수 안에서 등가 강제(호출자 우회 불가)
--     · source_kind tier2 폐쇄집합, 허용 밖은 조용한 0행이 아니라 예외
--     · p_limit 1..50 clamp
--     · 영벡터/NULL 임베딩 fail-close
--     · service_role only (anon·authenticated REVOKE)
--
-- ⚠️ 폐쇄집합을 유지하는 이유 — `document`(tier1 공식 간행물)는 **여전히 거부**한다.
--   tier1 이 이 경로로 새면 "tier1 근거일 때만 숫자 허용"(§12 수치 계약)이 깨진다.
--   공식 간행물은 전용 RPC `search_baseball_genius_official_chunks` 가 따로 담당한다.
--
-- 데이터 변경 0. 멱등(CREATE INDEX IF NOT EXISTS + CREATE OR REPLACE FUNCTION).
-- 롤백 = 이 파일 이전 정의로 CREATE OR REPLACE(=폐쇄집합을 'player' 로 되돌림).

-- 1) 조회 술어용 복합 인덱스 (이미 있으면 그대로) --------------------------------
-- entity 등가 필터가 먼저 좁힌 뒤 벡터 정렬이 돌도록 하는 목적. team 도 같은 술어를 탄다.
CREATE INDEX IF NOT EXISTS idx_genius_rag_chunks_entity_lookup
  ON public.genius_rag_chunks (entity_type, entity_id, source_kind, claim_generation);

-- 2) 검색 RPC — entity 폐쇄집합만 확장 -------------------------------------------
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
  -- tier2 폐쇄집합 밖은 조용히 0행으로 넘기지 않는다. 0행은 "미수집 entity"와 구분되지 않아
  -- 배선 실수가 fail-close 로 위장된다.
  IF p_source_kind IS NULL OR p_source_kind NOT IN ('namu_document', 'wikipedia_document') THEN
    RAISE EXCEPTION 'unsupported source_kind: %', p_source_kind;
  END IF;

  -- entity_type 도 같은 이유로 폐쇄집합이다. 이 RPC 는 **tier2 entity 경로**(선수·구단) 전용이라
  -- 'document'(tier1 공식 간행물)나 오타가 들어오면 조용히 0행이 아니라 드러나야 한다.
  IF p_entity_type IS NULL OR p_entity_type NOT IN ('player', 'team') THEN
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
  'tier2 entity(선수·구단) chunk 벡터 검색. 서빙 뷰만 읽고 entity_type/entity_id/source_kind 를 함수 안에서 강제하며 상한 50으로 clamp 한다. tier1 document 는 거부(전용 RPC 사용). 앱 최종 정렬을 위해 embedding 을 함께 반환한다.';
