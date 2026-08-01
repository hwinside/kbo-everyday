-- 야잘알봇 v2: KBO 공식 간행물(tier1) chunk 벡터 검색 RPC + 인덱스.
--
-- 왜 새 RPC인가 (선수 경로와 다른 점)
--   선수 서술형 질문은 entity_id로 문서 1건(선수 1명)까지 좁혀지므로 후보가 수십 개다.
--   그래서 앱이 chunk를 전부 받아 코사인을 다시 계산해도 됐다.
--   규칙·용어 질문은 다르다: "보크가 뭐야"만으로는 어느 간행물 몇 페이지에 답이 있는지 알 수 없어
--   **공식 문서 코퍼스 전체(현재 9,549 chunk)** 가 후보다. 이걸 앱으로 끌어오면 응답이 수 MB가 되고
--   768차원 코사인을 JS에서 수천 번 돌게 된다. 정렬은 pgvector가 인덱스로 끝내고 상위 N만 돌려준다.
--
-- 계약
--   1. 서빙 뷰(genius_rag_serving_chunks)만 읽는다 — active generation만 노출되므로 수집 중인
--      미완성 snapshot이 검색에 새지 않는다. 이 계약은 선수 경로와 동일하다.
--   2. **entity_type='document' AND source_grade='tier1'** 이중 제한. tier2 chunk가 이 경로로 새면
--      "tier1 근거일 때만 숫자 허용" 계약이 깨진다. 술어를 함수 안에 두어 호출자가 우회할 수 없다.
--   3. p_limit은 1..50으로 clamp한다. 상한 없는 정렬 조회는 query-guard 위반이고,
--      근거 수십 개를 프롬프트에 넣는 것도 의미가 없다.
--   4. embedding은 반환하지 않는다. 앱이 재정렬하지 않으므로 필요 없고, 응답만 무거워진다.
--   5. service_role 전용. anon/authenticated는 EXECUTE 불가 — 서버 route만 호출한다.
--
-- 멱등: CREATE INDEX IF NOT EXISTS + CREATE OR REPLACE FUNCTION.

-- 1) 벡터 인덱스 ---------------------------------------------------------------
-- 없으면 매 질문마다 전체 chunk seq scan + 코사인이다. HNSW는 pgvector 0.5+ 기본 제공이며
-- ivfflat과 달리 사전 학습(=대표 벡터 샘플링)이 필요 없어 적재 중에도 안전하게 만들 수 있다.
CREATE INDEX IF NOT EXISTS idx_genius_rag_chunks_embedding_hnsw
  ON public.genius_rag_chunks
  USING hnsw (embedding extensions.vector_cosine_ops);

-- 부분 인덱스: 공식 문서 검색은 항상 이 두 술어를 함께 쓴다.
CREATE INDEX IF NOT EXISTS idx_genius_rag_chunks_official_lookup
  ON public.genius_rag_chunks (source_key, claim_generation)
  WHERE entity_type = 'document' AND source_grade = 'tier1';

-- 2) 검색 RPC ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_baseball_genius_official_chunks(
  p_query_embedding text,
  p_limit integer DEFAULT 12
)
RETURNS TABLE (
  content text,
  page_title text,
  canonical_url text,
  revision text,
  section_path text,
  as_of date,
  source_grade text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 12), 1), 50);
  v_vec extensions.vector(768);
BEGIN
  -- 잘못된 벡터 문자열은 조용히 빈 결과로 만들지 않고 즉시 예외로 드러낸다.
  -- 조용히 0행을 돌리면 "공식 근거 없음"으로 오인되어 답변 경로가 말없이 퇴화한다.
  v_vec := p_query_embedding::extensions.vector(768);

  RETURN QUERY
  SELECT
    chunk.content,
    chunk.page_title,
    chunk.canonical_url,
    chunk.revision,
    chunk.section_path,
    chunk.as_of,
    chunk.source_grade
  FROM public.genius_rag_serving_chunks chunk
  WHERE chunk.entity_type = 'document'
    AND chunk.source_grade = 'tier1'
  ORDER BY chunk.embedding <=> v_vec
  LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.search_baseball_genius_official_chunks(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_baseball_genius_official_chunks(text, integer) TO service_role;

COMMENT ON FUNCTION public.search_baseball_genius_official_chunks(text, integer) IS
  'KBO 공식 간행물(tier1, entity_type=document) chunk 벡터 검색. 서빙 뷰만 읽고 상한 50으로 clamp한다.';
