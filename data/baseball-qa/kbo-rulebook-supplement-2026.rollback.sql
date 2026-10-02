-- Manual rollback only after the scoped application has been authorized.
-- NOT a migration. All pre-existing official sources and all vectors are preserved.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $rollback$
DECLARE expected jsonb; current_source public.genius_rag_sources%ROWTYPE;
BEGIN
  FOR expected IN SELECT value FROM jsonb_array_elements($expected$[{"key": "kbo:ebook:2026-공식야구규칙-필수-조항", "identity": "d200450bb54d55b17b32109ebf5d8ded00c515bc01b9e5b496f16c9dc56fcde5", "revision": "sha256:07651ec70e392723", "content_hash": "07651ec70e392723670a9aabcb86d2f9c1dd20fb91ad837af9abd8b0a86110d2", "pdf": "deb2c0d58ef41c6631f47a3dcfbe37d853a97275b9891ad50f0a8525b302a16a"}]$expected$::jsonb)
  LOOP
    SELECT * INTO current_source FROM public.genius_rag_sources
      WHERE source_key = expected->>'key' FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF current_source.identity_fingerprint IS DISTINCT FROM expected->>'identity'
      OR current_source.metadata->>'sourcePdfSha256' IS DISTINCT FROM expected->>'pdf'
      OR current_source.metadata->>'supplement' IS DISTINCT FROM 'true'
      OR (current_source.revision IS NOT NULL AND current_source.revision IS DISTINCT FROM expected->>'revision')
      OR (current_source.active_claim_generation > 0 AND
         (current_source.revision IS DISTINCT FROM expected->>'revision'
          OR current_source.content_hash IS DISTINCT FROM expected->>'content_hash'))
      OR current_source.lease_until > clock_timestamp() THEN
      RAISE EXCEPTION 'Rollback identity/revision/lease conflict for %', expected->>'key';
    END IF;
    UPDATE public.genius_rag_sources SET tombstoned_at = COALESCE(tombstoned_at, clock_timestamp())
      WHERE source_key = expected->>'key';
  END LOOP;
END $rollback$;
COMMIT;
-- Verify: the supplement key have zero serving rows; compare pre-application fingerprints.
