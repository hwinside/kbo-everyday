-- 야잘알봇: tier2 chunk 검색에 **시즌 lane** 을 연다 (삼순 2026-08-28 P0-①).
--
-- 왜 필요한가 (2026-08-28 실측)
--   구단 질문의 top1 이 과거 시즌 문서로 나온다:
--     `롯데 가을야구 갈 수 있을까?` → `롯데 자이언츠/2025년/9월`
--       ("이젠 자력으로 가을야구 진출 가능성은 거의 사라진 상황" — 작년 문서를 정확히 읽음)
--     `롯데 투수 선발진을 알려줘`   → `/2023년`·`/2025년`·`/2024년/총평`
--   나무위키 구단 문서는 `구단명/연도[/월]` 로 쪼개져 있고(한화 8,494청크 중 연도 문서가
--   2022~2026 각 300~600) 문장이 해마다 비슷해서 순수 코사인으로는 작년이 올해를 이긴다.
--
-- 🔴 앱에서 재정렬하는 것으로는 **못 고친다** (삼순 P0-①):
--   이 RPC 가 순수 코사인 상위 40 을 먼저 자른 뒤 앱이 가중하므로, 목표 시즌 청크가
--   41위 밖이면 앱이 아무리 가중해도 **복구 불가**다. 절단 전에 lane 을 확보해야 한다.
--   (같은 함정을 2026-08-05 에 겪었다 — 무순서 40건 절단으로 문보경 chunk_index 51 이
--    후보에조차 못 들어왔던 사고. 그때는 정렬을 DB 로 내렸고, 이번엔 lane 을 DB 로 내린다.)
--
-- 무엇을 바꾸는가 (최소 변경)
--   **기존 함수는 건드리지 않는다.** 새 오버로드를 추가한다:
--     `search_baseball_genius_player_chunks(..., p_season_mode text, p_season_year integer)`
--   기존 5인자 시그니처는 그대로 남아 종전 호출자(선수·뉴스 경로)가 영향을 받지 않는다.
--
--   `p_season_mode`:
--     'any'      기존과 동일 — 시즌 무관 전체에서 상위 N
--     'year'     문서 시즌이 `p_season_year` 인 문서만 (target-season lane)
--     'yearless' 문서 시즌이 없는 문서만 (상위 문서·역대 감독표·등번호·연혁 lane)
--
-- ── 🔴 parity (삼순 2026-08-28 재리뷰 P0-②) ────────────────────────────────────
--   초안은 `page_title || section_path` 를 통째로 정규식에 넣어 "연도가 등장하나"만 봤다.
--   그런데 앱(`parseEvidenceSeason`)은 **identity 우선 + 최대값 단일 시즌** 이다:
--     ① `page_title` + `canonical_url` 에 연도가 있으면 그 최대값이 문서 시즌이다
--     ② identity 에 연도가 없을 때만 `section_path` 를 보고, 거기서도 최대값
--   두 규칙이 다르면 실제 오염이 생긴다(삼순 지적 그대로, 실측으로도 재현됨):
--     · `롯데 자이언츠/2025년` 문서의 `2026년 전망` 섹션 → 초안 SQL 은 year(2026) lane 에
--       넣지만 앱은 2025 문서로 본다 = **과거 문서가 올해 lane 을 오염**
--     · `한화 이글스` 본문 문서의 `2017년 대비` 섹션 → 초안 SQL 은 yearless 에서 **탈락**
--       시키지만 앱은 identity 무연도 → section 최대값(2017)... 도 아니고,
--       앱 규칙상 section 을 보므로 2017 이다. 즉 **둘 다 yearless 가 아니다**.
--       (이 축은 아래 helper 가 앱과 동일하게 처리한다)
--   그래서 연도 판정을 **공유 helper 함수 하나**로 내리고 lane 은 그 결과만 비교한다.
--   판정 로직이 두 벌 존재하지 않으므로 갈라질 수 없다(SSOT).
--
--   ⚠️ 본문(`content`)은 보지 않는다 — `1986년 창단`·`1999년 우승` 같은 서술이
--     문서 시점으로 오인된다(실측: 경로 연도 없이 본문에만 연도가 있는 청크 362건).
--
-- 그 외 계약은 전부 그대로다:
--   · 서빙 뷰만 읽는다 · entity/source_kind 폐쇄집합 함수 내 강제 · p_limit 1..50 clamp
--   · 영벡터/NULL 임베딩 fail-close · service_role only
--
-- 데이터 변경 0. 멱등(CREATE OR REPLACE). 롤백 = 이 오버로드 DROP(기존 5인자는 무영향).

-- ── 문서 시즌 판정 helper — 앱 `parseEvidenceSeason` 의 SQL 대응물 ─────────────
--
-- 🔴 이 함수가 parity 의 SSOT 다. lane 필터는 이 결과만 비교하므로 "SQL 은 이렇게 보고
--   앱은 저렇게 본다" 가 원리적으로 불가능하다.
--
-- 앱과 동일 규칙:
--   ① identity = page_title + canonical_url 의 4자리 연도(19xx|20xx) → 있으면 최대값
--   ② 없으면 section_path 의 4자리 연도 → 있으면 최대값
--   ③ 둘 다 없으면 NULL (= yearless)
--
-- URL 퍼센트 인코딩: 나무위키 URL 은 **한글만** 인코딩하고 숫자는 그대로 남는다
--   (`%EC%9E%90` 형태 — 16진 쌍에 4자리 연속 10진수가 생기지 않는다).
--   그래도 인코딩 잔재가 오탐을 만들지 않도록 `%XX` 를 공백으로 치환한 뒤 연도를 찾는다.
--   앱은 `decodeURIComponent` 로 **디코드**하는데, 디코드 결과에 4자리 연도가 새로 생기려면
--   `%32%30%32%36` 처럼 숫자 자체가 인코딩돼 있어야 한다. 그런 URL 은 코퍼스에 없고
--   (parity 게이트가 전 코퍼스 형태로 대조한다), 생겨도 SQL 이 **더 보수적**으로 판정한다
--   (= 그 문서를 yearless 로 본다 → lane 이 좁아질 뿐 과거가 올해를 오염시키지 않는다).
CREATE OR REPLACE FUNCTION public.genius_doc_season(
  p_page_title text,
  p_canonical_url text,
  p_section_path text
)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH identity AS (
    SELECT max(m[1]::integer) AS season
    FROM regexp_matches(
      coalesce(p_page_title, '') || ' ' ||
      -- 퍼센트 이스케이프는 공백으로 — 인코딩 잔재가 연도로 오인되지 않게 한다.
      regexp_replace(coalesce(p_canonical_url, ''), '%[0-9a-fA-F]{2}', ' ', 'g'),
      '(19[0-9]{2}|20[0-9]{2})', 'g'
    ) AS m
  ), section AS (
    SELECT max(m[1]::integer) AS season
    FROM regexp_matches(coalesce(p_section_path, ''), '(19[0-9]{2}|20[0-9]{2})', 'g') AS m
  )
  -- identity 가 있으면 identity, 없을 때만 section (앱의 우선순위 그대로).
  SELECT coalesce((SELECT season FROM identity), (SELECT season FROM section));
$$;

REVOKE ALL ON FUNCTION public.genius_doc_season(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.genius_doc_season(text, text, text) TO service_role;

COMMENT ON FUNCTION public.genius_doc_season(text, text, text) IS
  '문서 시즌 판정 SSOT. 앱 parseEvidenceSeason 과 동일 규칙(identity=page_title+canonical_url 최대 연도 우선, 없으면 section_path 최대 연도, 둘 다 없으면 NULL). 본문은 보지 않는다. qa:genius-season-lane-parity 가 두 구현의 동치를 코퍼스 형태 전수로 고정한다.';

CREATE OR REPLACE FUNCTION public.search_baseball_genius_player_chunks(
  p_entity_type text,
  p_entity_id text,
  p_source_kind text,
  p_query_embedding text,
  p_limit integer,
  p_season_mode text,
  p_season_year integer
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
  IF p_source_kind IS NULL OR p_source_kind NOT IN ('namu_document', 'wikipedia_document') THEN
    RAISE EXCEPTION 'unsupported source_kind: %', p_source_kind;
  END IF;

  IF p_entity_type IS NULL OR p_entity_type NOT IN ('player', 'team') THEN
    RAISE EXCEPTION 'unsupported entity_type: %', p_entity_type;
  END IF;

  IF p_entity_id IS NULL OR btrim(p_entity_id) = '' THEN
    RAISE EXCEPTION 'entity_id is required';
  END IF;

  -- season_mode 도 폐쇄집합이다. 오타가 조용히 'any' 로 떨어지면 lane 이 사라진 것을
  -- 아무도 모른다(0행이 아니라 예외로 드러나야 한다).
  IF p_season_mode IS NULL OR p_season_mode NOT IN ('any', 'year', 'yearless') THEN
    RAISE EXCEPTION 'unsupported season_mode: %', p_season_mode;
  END IF;

  -- 'year' lane 인데 연도가 없으면 그 lane 은 정의되지 않는다. 조용한 전체 조회로
  -- 둔갑시키면 target lane 이 general lane 과 구분되지 않는다.
  IF p_season_mode = 'year' AND p_season_year IS NULL THEN
    RAISE EXCEPTION 'season_year is required when season_mode = year';
  END IF;

  IF p_query_embedding IS NULL THEN
    RAISE EXCEPTION 'query embedding is required';
  END IF;
  v_vec := p_query_embedding::extensions.vector(768);

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
    AND (
      p_season_mode = 'any'
      -- 🔴 lane 판정은 helper 결과만 본다 — 앱과 같은 함수적 정의라 갈라질 수 없다.
      OR (
        p_season_mode = 'yearless'
        AND public.genius_doc_season(chunk.page_title, chunk.canonical_url, chunk.section_path) IS NULL
      )
      OR (
        p_season_mode = 'year'
        AND public.genius_doc_season(chunk.page_title, chunk.canonical_url, chunk.section_path) = p_season_year
      )
    )
  ORDER BY chunk.embedding <=> v_vec
  LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.search_baseball_genius_player_chunks(text, text, text, text, integer, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_baseball_genius_player_chunks(text, text, text, text, integer, text, integer)
  TO service_role;

COMMENT ON FUNCTION public.search_baseball_genius_player_chunks(text, text, text, text, integer, text, integer) IS
  'tier2 entity chunk 벡터 검색 + 시즌 lane. season_mode=any|year|yearless. 연도 판정은 public.genius_doc_season(앱 parseEvidenceSeason 과 동일 규칙) 단일 SSOT 를 쓴다. DB 절단 전에 lane 을 확보해 목표 시즌 청크가 상위 40 밖으로 밀려 사라지는 recall 결함을 막는다.';
