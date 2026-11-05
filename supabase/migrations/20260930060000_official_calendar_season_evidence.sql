-- Return verified event-date season provenance without changing search scope,
-- distance thresholds, snapshot isolation, result limits, or role privileges.
-- Legacy snapshots return NULL: unknown is not the publication year.
DROP FUNCTION IF EXISTS public.search_baseball_genius_official_chunks(text, integer);
DROP FUNCTION IF EXISTS public.search_baseball_genius_official_chunks(text, integer, double precision);

CREATE FUNCTION public.search_baseball_genius_official_chunks(
  p_query_embedding text,
  p_limit integer DEFAULT 12,
  p_max_distance double precision DEFAULT 0.42
)
RETURNS TABLE (
  content text,
  page_title text,
  canonical_url text,
  revision text,
  section_path text,
  as_of date,
  source_grade text,
  distance double precision,
  calendar_season jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 12), 1), 50);
  -- 🔴 상한을 함수가 강제한다. 앱이 임계를 무력화(1.0)해 "근거 없이 답하는" 상태로
  --    되돌리는 것을 원리적으로 막는다. 하한(0.05)은 실수로 전 근거를 버리는 것을 막는다.
  v_max_distance double precision := least(greatest(coalesce(p_max_distance, 0.42), 0.05), 0.60);
  v_vec extensions.vector(768);
BEGIN
  -- 잘못된 벡터 문자열은 조용히 빈 결과로 만들지 않고 즉시 예외로 드러낸다.
  -- 조용히 0행을 돌리면 "공식 근거 없음"으로 오인되어 답변 경로가 말없이 퇴화한다.
  v_vec := p_query_embedding::extensions.vector(768);

  IF (v_vec OPERATOR(extensions.<=>) v_vec) <> 0 THEN
    RAISE EXCEPTION 'invalid query embedding';
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
    (chunk.embedding OPERATOR(extensions.<=>) v_vec)::double precision AS distance,
    chunk.metadata->'calendarSeason' AS calendar_season
  FROM public.genius_rag_serving_chunks chunk
  WHERE chunk.entity_type = 'document'
    AND chunk.source_grade = 'tier1'
    -- 임계는 WHERE 에 둔다. HNSW 인덱스가 ORDER BY 로 후보를 좁힌 뒤 걸러지므로
    -- 전체 스캔이 되지 않는다(정렬 축과 필터 축이 같은 연산자다).
    AND (chunk.embedding OPERATOR(extensions.<=>) v_vec) <= v_max_distance
  ORDER BY chunk.embedding OPERATOR(extensions.<=>) v_vec
  LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.search_baseball_genius_official_chunks(text, integer, double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_baseball_genius_official_chunks(text, integer, double precision) TO service_role;

COMMENT ON FUNCTION public.search_baseball_genius_official_chunks(text, integer, double precision) IS
  'KBO 공식 간행물(tier1, entity_type=document) chunk 벡터 검색. 서빙 뷰만 읽고 limit 50 clamp, '
  '유사도 거리 임계(기본 0.42, 0.05..0.60 clamp)를 넘는 chunk 는 반환하지 않는다 — '
  '임계가 없으면 무관한 질문도 항상 N건을 받아 "근거 있음"으로 오인된다(2026-08-27 실측).';
