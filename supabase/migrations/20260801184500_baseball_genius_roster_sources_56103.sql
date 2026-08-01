-- Append-only roster source delta for 2026-08-01.
-- Keep the reviewed 20260731 bootstrap seed immutable; later roster changes ship separately.

INSERT INTO public.genius_rag_sources AS target (
  source_key, source_kind, entity_type, entity_id, page_title, candidate_urls,
  canonical_url, resolution_status, resolution_note, source_grade, ingestion_status,
  identity_fingerprint, metadata
) VALUES
  ('namu:player:56103', 'namu_document', 'player', '56103', '카라스코', ARRAY['https://namu.wiki/w/%EC%B9%B4%EB%9D%BC%EC%8A%A4%EC%BD%94(%EC%95%BC%EA%B5%AC%EC%84%A0%EC%88%98)','https://namu.wiki/w/%EC%B9%B4%EB%9D%BC%EC%8A%A4%EC%BD%94','https://namu.wiki/w/%EC%B9%B4%EB%9D%BC%EC%8A%A4%EC%BD%94(%EC%95%BC%EA%B5%AC)']::text[], NULL, NULL, NULL, 'tier2', 'not_started', '42132b1b3f3e659da48f06f906d27156ff35123108aa13d8eb78fbfa98183169', '{"teamId":1,"team":"LG","candidateTitles":["카라스코(야구선수)","카라스코","카라스코(야구)"]}'::jsonb),
  ('namu:player:55435', 'namu_document', 'player', '55435', '차승준', ARRAY['https://namu.wiki/w/%EC%B0%A8%EC%8A%B9%EC%A4%80(%EC%95%BC%EA%B5%AC%EC%84%A0%EC%88%98)','https://namu.wiki/w/%EC%B0%A8%EC%8A%B9%EC%A4%80','https://namu.wiki/w/%EC%B0%A8%EC%8A%B9%EC%A4%80(%EC%95%BC%EA%B5%AC)']::text[], NULL, NULL, NULL, 'tier2', 'not_started', '6fc4fd1a9588b443e503b0d4106f58208227a12267b7d82625ce2187409c67dd', '{"teamId":1,"team":"LG","candidateTitles":["차승준(야구선수)","차승준","차승준(야구)"]}'::jsonb),
  ('namu:player:69428', 'namu_document', 'player', '69428', '이병헌', ARRAY['https://namu.wiki/w/%EC%9D%B4%EB%B3%91%ED%97%8C(%EC%95%BC%EA%B5%AC%EC%84%A0%EC%88%98)','https://namu.wiki/w/%EC%9D%B4%EB%B3%91%ED%97%8C','https://namu.wiki/w/%EC%9D%B4%EB%B3%91%ED%97%8C(%EC%95%BC%EA%B5%AC)']::text[], NULL, NULL, NULL, 'tier2', 'not_started', 'd8b3fe86d049fae9d1749b2f6fda4b71a35c939748d6ad3f18a58377a04b47e9', '{"teamId":1,"team":"LG","candidateTitles":["이병헌(야구선수)","이병헌","이병헌(야구)"]}'::jsonb)
ON CONFLICT (source_key) DO UPDATE SET
  page_title = EXCLUDED.page_title,
  candidate_urls = EXCLUDED.candidate_urls,
  identity_fingerprint = EXCLUDED.identity_fingerprint,
  metadata = EXCLUDED.metadata,
  updated_at = now();
