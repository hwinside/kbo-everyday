-- 야잘알봇 RAG-first 라우팅 ①: 공식 문서 검색에 **유사도 임계**를 도입한다.
--
-- 🔴 왜 필요한가 (2026-08-27 프로덕션 실측)
--   종전 RPC 는 `ORDER BY embedding <=> v_vec LIMIT n` 뿐이라 **무슨 질문이든 반드시 n건을
--   돌려준다.** 실측에서 야구와 무관한 질문도 예외 없이 12건을 받았다:
--       "오늘 점심 뭐 먹지?"      → 2026 KBO 연감 숫자표
--       "파이썬 리스트 정렬하는 법" → 기록대백과 숫자 나열
--       "아이폰 배터리 교체 비용"   → 가이드북 코치 프로필
--   즉 **결과 개수는 근거 유무의 증거가 전혀 아니다.** 그런데 RAG-first 라우팅은
--   "근거가 있으면 RAG로 답한다" 를 전제로 하므로, 개수로 판정하면 100% 통과가 되어
--   전 질문이 환각 통로가 된다. 근거의 **질**을 자를 축이 필요하다.
--
-- 🔑 임계값 근거 (같은 코퍼스 직접 질의, 코사인 거리 — 작을수록 가깝다)
--     진짜 근거 있음   0.2689 ~ 0.3787   (포스아웃/이닝교대/인필드플라이/피치/세이브조건)
--     야구 무관        0.4281 ~ 0.5139   (주식/날씨/점심/파이썬/아이폰)
--   두 분포가 겹치지 않고 0.40~0.42 에 경계가 있다. 기본값은 그 사이에서 **보수적으로
--   0.42**(= 근거를 조금 더 받아들이고, 최종 판정은 GROUNDED LLM 이 한다)로 둔다.
--
--   ⚠️ 이 값은 표본 15건의 **타당성 파일럿**이지 캘리브레이션이 아니다. 확정 전에
--      라벨링 세트로 재측정한다. 그래서 파라미터로 두되 **상한을 함수가 강제**한다 —
--      호출자가 1.0(=임계 무력화)을 넣어도 0.60 을 넘지 못한다. 임계 무력화는
--      "근거 없이 답한다" 와 같은 말이라 앱이 임의로 풀 수 있으면 안 된다.
--
-- 계약 (종전 계약은 전부 유지)
--   1. 서빙 뷰만 읽는다 · 2. entity_type='document' AND source_grade='tier1' 이중 제한
--   3. p_limit 1..50 clamp · 4. embedding 미반환 · 5. service_role 전용
--   6. **신규** p_max_distance 는 0.05..0.60 으로 clamp 하고, 거리를 함께 반환한다
--      (호출자가 관측·로깅할 수 있어야 임계를 나중에 재보정할 수 있다).
--
-- 하위호환: `distance` 컬럼이 늘어나므로 RETURNS TABLE 시그니처가 바뀐다.
--   plpgsql 은 반환 타입 변경 시 CREATE OR REPLACE 가 실패하므로 DROP 후 재생성한다.
--   호출자는 `search_baseball_genius_official_chunks(text, integer, double precision)` 하나뿐이며
--   같은 마이그레이션에서 앱 코드가 함께 갱신된다.
--
-- 멱등: DROP IF EXISTS + CREATE.

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
  distance double precision
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
    (chunk.embedding OPERATOR(extensions.<=>) v_vec)::double precision AS distance
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
