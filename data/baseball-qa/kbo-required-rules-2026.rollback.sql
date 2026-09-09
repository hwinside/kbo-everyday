-- Manual rollback only after the scoped application has been authorized.
-- NOT a migration. Existing 10 official sources and all vectors are preserved.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $rollback$
DECLARE expected jsonb; current_source public.genius_rag_sources%ROWTYPE;
BEGIN
  FOR expected IN SELECT value FROM jsonb_array_elements($expected$[{"key": "kbo:ebook:2026-kbo-리그-규정-필수-조항", "identity": "e34ceab381d0696ad9f8ae061c7e38e52e8124f4a95be3aa1549a9f304fd5c1a", "revision": "sha256:f5fb571016a86393", "content_hash": "f5fb571016a86393a5331f82e8d818d6a26008392a1e50c5d0ac42703b9580fd", "pdf": "9a0c2f21cad8c69b5bbfae3658f3057edbb317feb74c9f2a1dca1931a4d0d156"}, {"key": "kbo:ebook:2026-kbo-야구규약-필수-조항", "identity": "f2944df1e839b19317d13bbbe67a20c684d24b022f82ed0877f2ecdd0170d86a", "revision": "sha256:5d9127c6799317bd", "content_hash": "5d9127c6799317bdb4cd153e92296cc63b11652fd6b2c3abf16eae370753ba4a", "pdf": "127a572cb35b6819f219eea3e5144695403239f4934d36141b40ad63006a9cff"}]$expected$::jsonb)
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
-- Verify: these two keys have zero serving rows; compare original-10 fingerprints.
