-- Manual rollback only after the scoped application has been authorized.
-- NOT a migration. All pre-existing official sources and all vectors are preserved.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $rollback$
DECLARE expected jsonb; current_source public.genius_rag_sources%ROWTYPE;
BEGIN
  FOR expected IN SELECT value FROM jsonb_array_elements($expected$[{"key": "kbo:ebook:2026-공식야구규칙-필수-조항-510", "identity": "50c269ac0150e09edbff0866f93ceae65e7d8998f92641421639c2aafc59663b", "revision": "sha256:2342ad7c446a3fee", "content_hash": "2342ad7c446a3fee0c68549d0a33a020967d0e470b698bbbbe957ff154f86189", "pdf": "deb2c0d58ef41c6631f47a3dcfbe37d853a97275b9891ad50f0a8525b302a16a"}]$expected$::jsonb)
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
