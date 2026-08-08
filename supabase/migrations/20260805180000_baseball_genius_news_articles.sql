-- 야잘알봇: 최근 30일 구단 기사 RAG 원장.
--
-- 왜 필요한가
--   "어제 두산:LG전 3피트 룰 논란 설명해줘" / "LG가 왜 하반기에 안 좋아졌어?" 같은
--   **최신 경기·구단 맥락** 질문은 기존 근거로 답할 수 없다:
--     · 나무위키/위키 tier2 snapshot 은 수집 시점 고정이라 어제 경기를 모른다
--     · KBO 공식 e북(tier1)은 규정·기록 정본이지 사건 서술이 없다
--     · kbo_structured 는 수치 정본이지 "왜/무슨 일" 을 설명하지 못한다
--   반면 뉴스클리핑 cron 은 이미 매일 10개 구단 기사를 네이버에서 긁고 **버리고** 있다.
--   그 수집분을 적재해 근거로 쓰면 네이버 추가 호출 0 으로 최신 맥락을 얻는다.
--
-- 계약
--   1. **tier2 고정.** 언론 기사는 수치 정본이 아니다. §12 "수치는 tier1 근거일 때만" 계약에 따라
--      이 원장은 서술 근거로만 쓰고, 스코어·기록 수치는 kbo_structured 를 우선한다.
--      source_grade 컬럼을 두지 않고 tier2 임을 테이블 주석·소비 코드에서 고정한다.
--   2. **원문 저장 금지.** 네이버 검색 API 가 주는 제목 + description 발췌(약 100자)만 담는다.
--      언론사 본문 크롤은 하지 않는다(기존 news_discussions 주석과 동일한 방침).
--   3. **30일 롤링.** 시의성 없는 기사는 오답의 원인이다. 이중으로 막는다:
--        (a) 물리 삭제 — purge_baseball_genius_news_articles() 를 하루 1회 호출
--        (b) 검색단 차단 — 서빙 뷰 술어에 published_at >= now() - 30일
--      purge 가 한 번 밀려도 낡은 기사가 검색에 새지 않는다.
--   4. **embedding NULL = 검색 불가.** 적재(수집 cron)와 임베딩(별도 cron)을 분리하므로
--      임베딩 전 행이 존재한다. 서빙 뷰가 NULL 을 제외해 "적재됐지만 검색 안 되는" 행이
--      조용히 근거로 쓰이지 않게 한다.
--   5. 한 기사가 여러 구단에 걸린다(잠실 더비, 종합기사). team_ids 배열로 한 행을 공유해
--      같은 기사를 팀 수만큼 중복 임베딩하지 않는다.
--
-- 멱등: CREATE TABLE/INDEX IF NOT EXISTS + CREATE OR REPLACE.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.genius_news_articles (
  -- 네이버 link 의 sha256. 같은 기사를 여러 팀 쿼리가 물어와도 한 행으로 수렴한다.
  article_key text PRIMARY KEY,
  -- 이 기사가 근거가 될 수 있는 구단들. 빈 배열은 귀속 실패이므로 금지한다.
  team_ids integer[] NOT NULL CHECK (
    cardinality(team_ids) > 0
    AND team_ids <@ ARRAY[1,2,3,4,5,6,7,8,9,10]
  ),
  title text NOT NULL CHECK (btrim(title) <> ''),
  -- 네이버 description 발췌. 빈 발췌는 근거 가치가 없어 적재 단계에서 거른다.
  description text NOT NULL CHECK (btrim(description) <> ''),
  -- 임베딩·프롬프트에 그대로 들어가는 본문. 생성 컬럼이라 title/description 과 절대 어긋나지 않는다.
  content text GENERATED ALWAYS AS (title || E'\n' || description) STORED,
  link text NOT NULL,
  original_link text NOT NULL,
  -- 출처 표기용 언론사 호스트(예: news.chosun.com). 답변에 언론사·발행일·링크를 붙이기 위함.
  press_host text,
  published_at timestamptz NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT now(),
  content_hash text NOT NULL,
  -- NULL = 아직 임베딩 안 됨 → 서빙 뷰에서 제외된다.
  embedding extensions.vector(768),
  embedded_at timestamptz,
  embed_attempts integer NOT NULL DEFAULT 0 CHECK (embed_attempts BETWEEN 0 AND 5),
  last_embed_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- embedding 과 embedded_at 은 함께 간다. 한쪽만 있으면 "언제 임베딩됐는지 모르는 벡터" 또는
  -- "임베딩됐다고 표시됐는데 검색 불가한 행" 이 생겨 진단이 불가능해진다.
  CONSTRAINT genius_news_articles_embedding_pairing
    CHECK ((embedding IS NULL) = (embedded_at IS NULL))
);

COMMENT ON TABLE public.genius_news_articles IS
  '야잘알봇 최신 맥락 근거(tier2). 네이버 검색 API 제목+발췌만 보관하며 언론사 본문은 저장하지 않는다. published_at 기준 30일 롤링.';

-- 서빙 술어(팀 귀속 + 최신성)를 먼저 좁히기 위한 인덱스.
CREATE INDEX IF NOT EXISTS idx_genius_news_articles_team_published
  ON public.genius_news_articles USING gin (team_ids);

CREATE INDEX IF NOT EXISTS idx_genius_news_articles_published
  ON public.genius_news_articles (published_at DESC);

-- 임베딩 대기열 — embedding 이 없고 재시도 여유가 있는 행만.
CREATE INDEX IF NOT EXISTS idx_genius_news_articles_embed_queue
  ON public.genius_news_articles (published_at DESC)
  WHERE embedding IS NULL AND embed_attempts < 5;

-- 서빙 뷰 — 검색 경로는 이 뷰만 읽는다.
--   · embedding IS NOT NULL : 검색 불가능한 행 차단
--   · published_at 30일     : purge 가 밀려도 낡은 기사 차단(이중 방어)
-- SECURITY DEFINER 뷰(security_invoker 미지정)라 술어를 우회할 수 없다.
CREATE OR REPLACE VIEW public.genius_news_serving_articles AS
SELECT
  article.article_key,
  article.team_ids,
  article.title,
  article.description,
  article.content,
  article.link,
  article.original_link,
  article.press_host,
  article.published_at,
  article.embedding
FROM public.genius_news_articles article
WHERE article.embedding IS NOT NULL
  AND article.published_at >= now() - interval '30 days';

COMMENT ON VIEW public.genius_news_serving_articles IS
  '검색 가능한 기사만 노출. embedding NULL 과 30일 초과분을 술어로 차단한다(물리 purge 와 이중 방어).';

-- 뷰 자체 ACL — security-definer 뷰는 소유자 권한으로 읽어 기저 테이블의 RLS 를 **우회**한다.
-- 그러므로 기저 테이블에 RLS 를 켜놓은 것만으로는 보호가 안 된다 — 뷰에 직접 SELECT 하면
-- 그대로 읽힌다. 서버 전용 계약을 뷰 자체에서 자립시킨다.
REVOKE ALL ON public.genius_news_serving_articles FROM PUBLIC;
REVOKE ALL ON public.genius_news_serving_articles FROM anon, authenticated;
GRANT SELECT ON public.genius_news_serving_articles TO service_role;

-- 적재 커버리지 원장.
--
-- 왜 필요한가
--   적재 결과를 응답 JSON 으로만 흘리면 "어제 롯데 기사가 0건인 것" 과 "롯데 수집이 실패해
--   아예 안 돈 것" 과 "페이지 상한에 걸려 일부만 담긴 것" 이 사후에 구분되지 않는다.
--   근거가 조용히 비는 것이 야잘알봇에서 가장 위험한 실패 모드라서, 팀×날짜 단위로
--   무엇이 얼마나 들어왔는지·왜 못 들어왔는지를 원장에 남긴다.
--
-- 계약
--   · 팀 10개 × 날짜마다 **항상 한 행**이 남는다. 행이 없으면 그 자체가 "cron 이 안 돌았다" 는 신호다.
--   · collected=0 이어도 status='ok' 로 기록한다(휴식일). 실패는 status 로만 표현한다.
--   · truncated=true 는 네이버 페이지 상한에 걸려 그날 기사 전부를 보지 못했다는 뜻이다.
CREATE TABLE IF NOT EXISTS public.genius_news_ingest_coverage (
  clip_date date NOT NULL,
  team_id integer NOT NULL CHECK (team_id BETWEEN 1 AND 10),
  -- 수집된 raw 후보 수(적재 필터 통과분).
  collected integer NOT NULL DEFAULT 0 CHECK (collected >= 0),
  -- 원장에 실제로 반영된 행 수(신규 + 갱신).
  ingested integer NOT NULL DEFAULT 0 CHECK (ingested >= 0),
  -- 네이버 페이지 상한에 걸려 그날 기사를 다 못 봤는가.
  truncated boolean NOT NULL DEFAULT false,
  pages_fetched integer NOT NULL DEFAULT 0 CHECK (pages_fetched >= 0),
  -- 'api_unreached' = 검색 API 결과창(start 상한) 때문에 **그날까지 닿지도 못했다**는 뜻이다.
  -- 기사가 없어서 0건인 'ok' 과 구분된다 — 이 둘을 섞으면 커버리지 증명 자체가 무의미해진다.
  status text NOT NULL CHECK (
    status IN ('ok', 'collect_failed', 'ingest_failed', 'ingest_timeout', 'api_unreached')
  ),
  detail text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clip_date, team_id)
);

-- 백필 증명용 컬럼 — 응답 JSON 에만 있으면 실행이 끝나는 순간 사라져 "10팀×14일 확보"를
-- 나중에 증명할 수 없다. 기존 배포본을 깨지 않게 ADD COLUMN IF NOT EXISTS 로 내려박는다.
ALTER TABLE public.genius_news_ingest_coverage
  ADD COLUMN IF NOT EXISTS reached_api_limit boolean NOT NULL DEFAULT false;
ALTER TABLE public.genius_news_ingest_coverage
  ADD COLUMN IF NOT EXISTS oldest_reached date;
-- 이 칸을 만드는 데 실제로 쓴 쿼리 수(fan-out 포함). 1 = broad 하나로 충분했다는 뜻.
ALTER TABLE public.genius_news_ingest_coverage
  ADD COLUMN IF NOT EXISTS queries_used integer NOT NULL DEFAULT 0;

COMMENT ON TABLE public.genius_news_ingest_coverage IS
  '기사 근거 적재 커버리지(팀×날짜). 0건(ok)·수집실패·적재실패·API미도달(api_unreached)을 구분하는 원장. 백필 범위 확보를 이 표로 증명한다.';

ALTER TABLE public.genius_news_ingest_coverage ENABLE ROW LEVEL SECURITY;

-- 30일 초과 물리 삭제. 하루 1회 cron 이 호출한다. 삭제 행 수를 반환해 무동작을 감지할 수 있게 한다.
-- 커버리지 원장도 같은 창으로 정리하되, 반환값은 **기사 삭제 수**로 유지한다(진단 지표 혼선 방지).
CREATE OR REPLACE FUNCTION public.purge_baseball_genius_news_articles()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.genius_news_articles
  WHERE published_at < now() - interval '30 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  DELETE FROM public.genius_news_ingest_coverage
  WHERE clip_date < (now() - interval '30 days')::date;

  RETURN v_deleted;
END;
$$;

-- 기사 원장 원자 병합 upsert.
--
-- 왜 애플리케이션이 아니라 DB 인가
--   read(team_ids) → union(JS) → write 순서로 하면 두 가지가 동시에 깨진다:
--     (a) 조회가 실패했는데 write 를 계속하면 기존 team_ids 를 **덮어써** 다른 팀 근거가 사라진다
--     (b) 두 실행이 겹치면 각자 읽은 낡은 team_ids 로 써서 합집합이 유실된다(lost update)
--   합집합을 ON CONFLICT DO UPDATE 안에서 계산하면 두 경우 모두 구조적으로 불가능해진다.
--   조회 자체가 없으므로 "조회 실패 후 덮어쓰기" 라는 상태가 존재할 수 없다.
--
-- 계약
--   · team_ids 는 **항상 기존 ∪ 신규**. 축소하지 않는다.
--   · content_hash 가 바뀐 행만 임베딩을 무효화한다. 안 바뀐 행을 건드리면 매일 전량 재임베딩이 된다.
--   · 같은 배치 안 중복 article_key 는 여기서 합쳐진다. 안 합치면 ON CONFLICT 가
--     "cannot affect row a second time" 로 배치 전체를 실패시킨다.
--   · 잘못된 입력(배열 아님/상한 초과)은 조용한 0행이 아니라 예외다.
CREATE OR REPLACE FUNCTION public.upsert_baseball_genius_news_articles(p_rows jsonb)
RETURNS TABLE (inserted integer, updated integer, reembed_queued integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'rows must be a jsonb array';
  END IF;

  v_count := jsonb_array_length(p_rows);
  IF v_count = 0 THEN
    RETURN QUERY SELECT 0, 0, 0;
    RETURN;
  END IF;

  -- 상한 없는 배치는 한 번의 실수로 트랜잭션을 무한정 키운다. 호출측 청크 크기와 결속.
  IF v_count > 500 THEN
    RAISE EXCEPTION 'batch too large: % (max 500)', v_count;
  END IF;

  RETURN QUERY
  WITH incoming AS (
    SELECT *
    FROM jsonb_to_recordset(p_rows) AS r(
      article_key text,
      team_ids integer[],
      title text,
      description text,
      link text,
      original_link text,
      press_host text,
      published_at timestamptz,
      content_hash text
    )
  ),
  flat AS (
    SELECT i.article_key, t AS team_id
    FROM incoming i, unnest(i.team_ids) AS t
  ),
  deduped AS (
    SELECT DISTINCT ON (i.article_key)
      i.article_key,
      (
        SELECT array_agg(DISTINCT f.team_id ORDER BY f.team_id)
        FROM flat f
        WHERE f.article_key = i.article_key
      ) AS team_ids,
      i.title, i.description, i.link, i.original_link,
      i.press_host, i.published_at, i.content_hash
    FROM incoming i
    ORDER BY i.article_key, i.published_at DESC
  ),
  prior AS (
    SELECT d.article_key, a.content_hash AS old_hash, (a.article_key IS NOT NULL) AS existed
    FROM deduped d
    LEFT JOIN public.genius_news_articles a ON a.article_key = d.article_key
  ),
  merged AS (
    INSERT INTO public.genius_news_articles AS target (
      article_key, team_ids, title, description, link, original_link,
      press_host, published_at, content_hash, updated_at
    )
    SELECT
      d.article_key, d.team_ids, d.title, d.description, d.link, d.original_link,
      d.press_host, d.published_at, d.content_hash, now()
    FROM deduped d
    ON CONFLICT (article_key) DO UPDATE SET
      -- 합집합. 덮어쓰면 다른 팀 쿼리로 들어왔던 근거가 사라진다.
      team_ids = (
        SELECT array_agg(DISTINCT t ORDER BY t)
        FROM unnest(target.team_ids || EXCLUDED.team_ids) AS t
      ),
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      link = EXCLUDED.link,
      original_link = EXCLUDED.original_link,
      press_host = EXCLUDED.press_host,
      published_at = EXCLUDED.published_at,
      content_hash = EXCLUDED.content_hash,
      updated_at = now(),
      embedding = CASE
        WHEN target.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN NULL
        ELSE target.embedding END,
      embedded_at = CASE
        WHEN target.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN NULL
        ELSE target.embedded_at END,
      embed_attempts = CASE
        WHEN target.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN 0
        ELSE target.embed_attempts END,
      last_embed_error = CASE
        WHEN target.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN NULL
        ELSE target.last_embed_error END
    RETURNING target.article_key, target.content_hash AS new_hash
  )
  SELECT
    count(*) FILTER (WHERE NOT p.existed)::integer,
    count(*) FILTER (WHERE p.existed)::integer,
    count(*) FILTER (WHERE NOT p.existed OR p.old_hash IS DISTINCT FROM m.new_hash)::integer
  FROM merged m
  JOIN prior p ON p.article_key = m.article_key;
END;
$$;

-- 커버리지 원장 기록. 팀×날짜 upsert — 재실행해도 행이 늘지 않는다.
CREATE OR REPLACE FUNCTION public.record_baseball_genius_news_coverage(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_written integer;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'rows must be a jsonb array';
  END IF;
  IF jsonb_array_length(p_rows) = 0 THEN
    RETURN 0;
  END IF;

  INSERT INTO public.genius_news_ingest_coverage AS target (
    clip_date, team_id, collected, ingested, truncated, pages_fetched, status, detail,
    reached_api_limit, oldest_reached, queries_used, updated_at
  )
  SELECT
    r.clip_date, r.team_id,
    coalesce(r.collected, 0), coalesce(r.ingested, 0),
    coalesce(r.truncated, false), coalesce(r.pages_fetched, 0),
    r.status, r.detail,
    coalesce(r.reached_api_limit, false), r.oldest_reached, coalesce(r.queries_used, 0),
    now()
  FROM jsonb_to_recordset(p_rows) AS r(
    clip_date date,
    team_id integer,
    collected integer,
    ingested integer,
    truncated boolean,
    pages_fetched integer,
    status text,
    detail text,
    reached_api_limit boolean,
    oldest_reached date,
    queries_used integer
  )
  ON CONFLICT (clip_date, team_id) DO UPDATE SET
    collected = EXCLUDED.collected,
    ingested = EXCLUDED.ingested,
    truncated = EXCLUDED.truncated,
    pages_fetched = EXCLUDED.pages_fetched,
    status = EXCLUDED.status,
    detail = EXCLUDED.detail,
    reached_api_limit = EXCLUDED.reached_api_limit,
    oldest_reached = EXCLUDED.oldest_reached,
    queries_used = EXCLUDED.queries_used,
    updated_at = now();

  GET DIAGNOSTICS v_written = ROW_COUNT;
  RETURN v_written;
END;
$$;

-- 기사 벡터 검색 RPC.
--   선수 chunk RPC(search_baseball_genius_player_chunks)와 같은 원칙:
--   서빙 뷰만 읽고, 술어는 함수 안에서 강제하며, 잘못된 입력은 조용한 0행이 아니라 예외다.
--   0행은 "그 팀 기사가 없음" 과 "배선 실수" 를 구분하지 못해 fail-close 로 위장되기 때문이다.
CREATE OR REPLACE FUNCTION public.search_baseball_genius_news_articles(
  p_team_ids integer[],
  p_query_embedding text,
  p_limit integer DEFAULT 40,
  p_published_after timestamptz DEFAULT NULL
)
RETURNS TABLE (
  article_key text,
  team_ids integer[],
  title text,
  description text,
  content text,
  link text,
  original_link text,
  press_host text,
  published_at timestamptz
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
  IF p_team_ids IS NULL OR cardinality(p_team_ids) = 0 THEN
    RAISE EXCEPTION 'team_ids is required';
  END IF;

  IF NOT (p_team_ids <@ ARRAY[1,2,3,4,5,6,7,8,9,10]) THEN
    RAISE EXCEPTION 'unsupported team id in %', p_team_ids;
  END IF;

  IF p_query_embedding IS NULL OR btrim(p_query_embedding) = '' THEN
    RAISE EXCEPTION 'query embedding is required';
  END IF;

  v_vec := p_query_embedding::extensions.vector(768);

  -- 영벡터는 코사인 거리가 정의되지 않아(NaN) 정렬이 무의미해진다. 그대로 두면
  -- "관련도 순" 이 사실상 "아무 40건" 이 되므로 조용히 통과시키지 않는다.
  -- 자기 자신과의 거리는 정상 벡터면 0 이고 영벡터면 NaN 이다. `IS NULL` 은 NaN 을
  -- 잡지 못해 검사가 무효화되므로(실측) `<> 0` 으로 판정한다 — 선수 chunk RPC 와 동일.
  IF (v_vec OPERATOR(extensions.<=>) v_vec) <> 0 THEN
    RAISE EXCEPTION 'query embedding is degenerate (zero vector)';
  END IF;

  RETURN QUERY
  SELECT
    serving.article_key,
    serving.team_ids,
    serving.title,
    serving.description,
    serving.content,
    serving.link,
    serving.original_link,
    serving.press_host,
    serving.published_at
  FROM public.genius_news_serving_articles serving
  WHERE serving.team_ids && p_team_ids
    AND (p_published_after IS NULL OR serving.published_at >= p_published_after)
  ORDER BY serving.embedding <=> v_vec
  LIMIT v_limit;
END;
$$;

-- 서버(cron·API, service_role) 전용. RLS on + 정책 0개 = 일반 클라 직접 접근 전부 거부.
ALTER TABLE public.genius_news_articles ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON FUNCTION public.purge_baseball_genius_news_articles() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_baseball_genius_news_articles() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_baseball_genius_news_articles() TO service_role;

REVOKE ALL ON FUNCTION public.search_baseball_genius_news_articles(integer[], text, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.search_baseball_genius_news_articles(integer[], text, integer, timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_baseball_genius_news_articles(integer[], text, integer, timestamptz) TO service_role;

REVOKE ALL ON FUNCTION public.upsert_baseball_genius_news_articles(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_baseball_genius_news_articles(jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_baseball_genius_news_articles(jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.record_baseball_genius_news_coverage(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_baseball_genius_news_coverage(jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_baseball_genius_news_coverage(jsonb) TO service_role;
