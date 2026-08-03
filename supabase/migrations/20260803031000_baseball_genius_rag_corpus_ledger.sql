-- A17/Mac 혼합 corpus의 물리행 전량을 serving과 분리된 durable ledger에 보존한다.
-- 같은 owner+canonical의 과거 revision도 row_index로 보존하며, quarantined 행은 절대 serving view에 없다.
CREATE TABLE IF NOT EXISTS public.genius_rag_corpus_runs (
  artifact_sha256 text PRIMARY KEY CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  expected_rows integer NOT NULL CHECK (expected_rows > 0),
  assigned_rows integer,
  quarantined_rows integer,
  latest_owner_relations integer,
  collector_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'loading' CHECK (status IN ('loading', 'ready')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.genius_rag_corpus_records (
  artifact_sha256 text NOT NULL REFERENCES public.genius_rag_corpus_runs(artifact_sha256) ON DELETE CASCADE,
  row_index integer NOT NULL CHECK (row_index >= 0),
  record_hash text NOT NULL CHECK (record_hash ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('player', 'team', 'baseball_general', 'kbo_league')),
  entity text NOT NULL,
  doc text NOT NULL,
  depth integer NOT NULL CHECK (depth >= 1),
  page_title text NOT NULL,
  canonical_url text NOT NULL CHECK (canonical_url ~ '^https://namu[.]wiki/w/[^?#]+$'),
  fetched_at timestamptz NOT NULL,
  -- PostgreSQL char_length와 동일한 Unicode code point 수다(JS UTF-16 code unit 수가 아님).
  content_length integer NOT NULL CHECK (content_length > 0),
  raw_text text NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('assigned', 'quarantined')),
  is_latest_owner_revision boolean NOT NULL,
  collector text NOT NULL CHECK (collector IN ('a17_self_cdp', 'mac_direct_recovery')),
  CHECK (char_length(raw_text) = content_length),
  PRIMARY KEY (artifact_sha256, row_index)
);

ALTER TABLE public.genius_rag_corpus_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.genius_rag_corpus_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS genius_rag_corpus_runs_service_all ON public.genius_rag_corpus_runs;
CREATE POLICY genius_rag_corpus_runs_service_all ON public.genius_rag_corpus_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS genius_rag_corpus_records_service_all ON public.genius_rag_corpus_records;
CREATE POLICY genius_rag_corpus_records_service_all ON public.genius_rag_corpus_records
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.genius_rag_corpus_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.genius_rag_corpus_records FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.genius_rag_corpus_runs TO service_role;
GRANT ALL ON TABLE public.genius_rag_corpus_records TO service_role;

CREATE OR REPLACE FUNCTION public.finalize_baseball_genius_rag_corpus_ledger(p_artifact_sha256 text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_run public.genius_rag_corpus_runs%ROWTYPE;
  v_total integer;
  v_assigned integer;
  v_quarantined integer;
  v_latest integer;
  v_min_index integer;
  v_max_index integer;
  v_collectors jsonb;
BEGIN
  SELECT * INTO v_run FROM public.genius_rag_corpus_runs
   WHERE artifact_sha256 = p_artifact_sha256 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'corpus run absent'; END IF;

  SELECT count(*)::integer,
         min(row_index)::integer,
         max(row_index)::integer,
         count(*) FILTER (WHERE disposition='assigned')::integer,
         count(*) FILTER (WHERE disposition='quarantined')::integer,
         count(*) FILTER (WHERE is_latest_owner_revision)::integer,
         jsonb_build_object(
           'a17_self_cdp', count(*) FILTER (WHERE collector='a17_self_cdp'),
           'mac_direct_recovery', count(*) FILTER (WHERE collector='mac_direct_recovery')
         )
    INTO v_total,v_min_index,v_max_index,v_assigned,v_quarantined,v_latest,v_collectors
    FROM public.genius_rag_corpus_records WHERE artifact_sha256=p_artifact_sha256;

  IF v_total <> v_run.expected_rows
     OR v_min_index <> 0
     OR v_max_index <> v_run.expected_rows - 1
     OR v_assigned + v_quarantined <> v_run.expected_rows THEN
    RAISE EXCEPTION 'corpus ledger count mismatch expected=% actual=% assigned=% quarantined=%',
      v_run.expected_rows,v_total,v_assigned,v_quarantined;
  END IF;
  UPDATE public.genius_rag_corpus_runs
     SET assigned_rows=v_assigned, quarantined_rows=v_quarantined,
         latest_owner_relations=v_latest, collector_counts=v_collectors,
         status='ready', completed_at=now()
   WHERE artifact_sha256=p_artifact_sha256;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_baseball_genius_rag_corpus_ledger(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_baseball_genius_rag_corpus_ledger(text) TO service_role;

-- corpus source content_hash는 root 문서 hash가 아니라 child/provenance까지 포함한 prepared
-- snapshot fingerprint다. 공식 문서 complete RPC의 root document hash 계약과 분리한다.
CREATE OR REPLACE FUNCTION public.complete_baseball_genius_rag_corpus_source(
  p_source_key text,
  p_claim_token uuid,
  p_claim_generation bigint,
  p_revision text,
  p_content_hash text,
  p_crawled_at timestamptz,
  p_stale_after timestamptz,
  p_expected_chunk_count integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_completed boolean;
BEGIN
  IF p_expected_chunk_count < 1 OR p_content_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'valid snapshot hash and positive chunk count are required';
  END IF;

  UPDATE public.genius_rag_sources source
  SET ingestion_status = 'ready', ingestion_attempts = 0,
      active_claim_generation = p_claim_generation,
      revision = p_revision, content_hash = p_content_hash,
      crawled_at = p_crawled_at, ingested_at = clock_timestamp(), stale_after = p_stale_after,
      lease_until = NULL, claim_token = NULL, last_error = NULL,
      metadata = (CASE WHEN source.metadata ? 'pendingLoaderRevision' THEN
        (source.metadata - 'pendingLoaderRevision')
        || jsonb_build_object('loaderRevision', source.metadata->>'pendingLoaderRevision')
        ELSE source.metadata END)
        || jsonb_build_object('contentHashMode','prepared_snapshot'),
      updated_at = now()
  WHERE source.source_key = p_source_key
    AND source.ingestion_status = 'ingesting'
    AND source.claim_token = p_claim_token
    AND source.claim_generation = p_claim_generation
    AND source.lease_until > clock_timestamp()
    AND EXISTS (
      SELECT 1 FROM public.genius_rag_chunks chunk
      WHERE chunk.source_key = source.source_key
        AND chunk.claim_token = p_claim_token
        AND chunk.claim_generation = p_claim_generation
        AND chunk.revision = p_revision
        AND chunk.canonical_url = source.canonical_url
        AND chunk.crawled_at = p_crawled_at
        AND chunk.embedding IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.genius_rag_chunks chunk
      WHERE chunk.source_key = source.source_key
        AND chunk.claim_generation = p_claim_generation
        AND (chunk.embedding IS NULL OR chunk.claim_token IS DISTINCT FROM p_claim_token)
    )
    AND (
      SELECT count(*) FROM public.genius_rag_chunks chunk
      WHERE chunk.source_key = source.source_key
        AND chunk.claim_generation = p_claim_generation
    ) = p_expected_chunk_count
  RETURNING true INTO v_completed;

  IF coalesce(v_completed, false) THEN
    DELETE FROM public.genius_rag_chunks chunk
    WHERE chunk.source_key = p_source_key AND chunk.claim_generation <> p_claim_generation;
  END IF;
  RETURN coalesce(v_completed, false);
END;
$$;

REVOKE ALL ON FUNCTION public.complete_baseball_genius_rag_corpus_source(
  text, uuid, bigint, text, text, timestamptz, timestamptz, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_baseball_genius_rag_corpus_source(
  text, uuid, bigint, text, text, timestamptz, timestamptz, integer
) TO service_role;

-- 기존 ready trigger는 source.content_hash가 anchor document hash라고 가정한다. corpus만
-- metadata marker로 prepared snapshot hash 계약을 선택하고, active generation provenance는
-- 별도로 그대로 검증한다.
CREATE OR REPLACE FUNCTION public.validate_baseball_genius_rag_ready()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.ingestion_status = 'ready' AND NOT EXISTS (
    SELECT 1 FROM public.genius_rag_chunks chunk
    WHERE chunk.source_key = NEW.source_key
      AND chunk.claim_generation = NEW.active_claim_generation
      AND chunk.revision = NEW.revision
      AND (
        (NEW.metadata->>'contentHashMode' = 'prepared_snapshot'
          AND chunk.canonical_url = NEW.canonical_url)
        OR (NEW.metadata->>'contentHashMode' IS DISTINCT FROM 'prepared_snapshot'
          AND chunk.document_content_hash = NEW.content_hash
          AND chunk.canonical_url = NEW.canonical_url)
      )
      AND chunk.entity_type = NEW.entity_type
      AND chunk.entity_id = NEW.entity_id
      AND chunk.page_title = NEW.page_title
      AND chunk.source_grade = NEW.source_grade
      AND chunk.crawled_at = NEW.crawled_at
      AND chunk.embedding IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'ready rag source requires matching provenance chunk';
  END IF;
  RETURN NEW;
END;
$$;
