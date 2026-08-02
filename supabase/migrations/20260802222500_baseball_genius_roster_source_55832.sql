-- Append-only roster source delta for 2026-08-02.
-- Keep the reviewed 20260731 bootstrap seed immutable; later roster changes ship separately.

INSERT INTO public.genius_rag_sources AS target (
  source_key, source_kind, entity_type, entity_id, page_title, candidate_urls,
  canonical_url, resolution_status, resolution_note, source_grade, ingestion_status,
  identity_fingerprint, metadata
) VALUES (
  'namu:player:55832',
  'namu_document',
  'player',
  '55832',
  '이율예',
  ARRAY[
    'https://namu.wiki/w/%EC%9D%B4%EC%9C%A8%EC%98%88(%EC%95%BC%EA%B5%AC%EC%84%A0%EC%88%98)',
    'https://namu.wiki/w/%EC%9D%B4%EC%9C%A8%EC%98%88',
    'https://namu.wiki/w/%EC%9D%B4%EC%9C%A8%EC%98%88(%EC%95%BC%EA%B5%AC)'
  ]::text[],
  NULL,
  NULL,
  NULL,
  'tier2',
  'not_started',
  'c634a07aac915a722f23e509c1e27f3fce7f799f4d29def6332acf8c0b89e8b1',
  '{"teamId":4,"team":"SSG","candidateTitles":["이율예(야구선수)","이율예","이율예(야구)"]}'::jsonb
)
ON CONFLICT (source_key) DO UPDATE SET
  page_title = EXCLUDED.page_title,
  candidate_urls = EXCLUDED.candidate_urls,
  identity_fingerprint = EXCLUDED.identity_fingerprint,
  metadata = EXCLUDED.metadata,
  updated_at = now();
