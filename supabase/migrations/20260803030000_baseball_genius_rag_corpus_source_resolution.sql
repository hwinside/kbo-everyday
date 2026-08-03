-- A17 corpus loader가 source와 chunk의 신원을 한 UPDATE로 정렬한다.
--
-- seed의 등록명(레이예스/올러)과 실제 canonical 문서명(레예스/아담 올러)이 다를 수 있다.
-- canonical만 PATCH하면 chunk owner trigger의 page_title exact 계약에서 전량 적재가 중단된다.
-- fingerprint 변경은 기존 identity-drift trigger가 READY snapshot/claim을 원자 무효화한다.
CREATE OR REPLACE FUNCTION public.resolve_baseball_genius_rag_corpus_source(
  p_source_key text,
  p_source_kind text,
  p_entity_type text,
  p_entity_id text,
  p_page_title text,
  p_candidate_urls text[],
  p_canonical_url text,
  p_resolution_note text,
  p_identity_fingerprint text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_affected integer;
BEGIN
  IF p_source_kind IS DISTINCT FROM 'namu_document'
     OR p_entity_type NOT IN ('player', 'team', 'league')
     OR coalesce(btrim(p_source_key), '') = ''
     OR coalesce(btrim(p_entity_id), '') = ''
     OR coalesce(btrim(p_page_title), '') = ''
     OR coalesce(btrim(p_resolution_note), '') = ''
     OR p_canonical_url !~ '^https://namu[.]wiki/w/[^?#]+$'
     OR cardinality(p_candidate_urls) IS DISTINCT FROM 1
     OR p_candidate_urls[1] IS DISTINCT FROM p_canonical_url
     OR p_identity_fingerprint !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'invalid corpus source identity payload';
  END IF;

  UPDATE public.genius_rag_sources
  SET page_title = p_page_title,
      candidate_urls = p_candidate_urls,
      canonical_url = p_canonical_url,
      resolution_status = 'resolved',
      resolution_note = p_resolution_note,
      identity_fingerprint = p_identity_fingerprint,
      updated_at = now()
  WHERE source_key = p_source_key
    AND source_kind = p_source_kind
    AND entity_type = p_entity_type
    AND entity_id = p_entity_id
    AND source_grade = 'tier2';

  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected <> 1 THEN
    RAISE EXCEPTION USING errcode = 'P0001',
      message = format('corpus source resolve count mismatch source=%s actual=%s', p_source_key, v_affected);
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_baseball_genius_rag_corpus_source(
  text, text, text, text, text, text[], text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_baseball_genius_rag_corpus_source(
  text, text, text, text, text, text[], text, text, text
) TO service_role;
