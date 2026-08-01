-- Add the roster source introduced after the original inventory seed was deployed.
INSERT INTO public.genius_rag_sources (
  source_key, source_kind, entity_type, entity_id, page_title, candidate_urls,
  canonical_url, resolution_status, resolution_note, source_grade, ingestion_status,
  identity_fingerprint, metadata
) VALUES (
  'namu:player:56103',
  'namu_document',
  'player',
  '56103',
  '카라스코',
  ARRAY[
    'https://namu.wiki/w/%EC%B9%B4%EB%9D%BC%EC%8A%A4%EC%BD%94(%EC%95%BC%EA%B5%AC%EC%84%A0%EC%88%98)',
    'https://namu.wiki/w/%EC%B9%B4%EB%9D%BC%EC%8A%A4%EC%BD%94',
    'https://namu.wiki/w/%EC%B9%B4%EB%9D%BC%EC%8A%A4%EC%BD%94(%EC%95%BC%EA%B5%AC)'
  ]::text[],
  NULL,
  NULL,
  NULL,
  'tier2',
  'not_started',
  '42132b1b3f3e659da48f06f906d27156ff35123108aa13d8eb78fbfa98183169',
  '{"teamId":1,"team":"LG","candidateTitles":["카라스코(야구선수)","카라스코","카라스코(야구)"]}'::jsonb
)
ON CONFLICT (source_key) DO NOTHING;
