-- Scoped CAS correction. Historical seed/tone migrations and their fixtures stay immutable.
-- Source: 2026 KBO 리그 규정 제1장 제1조 제2항 / 제2조, PDF 13쪽.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';
DO $body$
DECLARE current_row public.baseball_terms%ROWTYPE;
BEGIN
  SELECT * INTO current_row FROM public.baseball_terms WHERE term = '무승부' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'innings glossary missing term: 무승부'; END IF;
  IF current_row.term IS NOT DISTINCT FROM '무승부'
      AND current_row.answer IS NOT DISTINCT FROM '2026 KBO 리그 규정 기준 연장전은 정규시즌 11회, 포스트시즌 15회까지 진행하며, 그때까지 승패를 가리지 못하면 무승부입니다.
승률 계산에서 무승부는 승수에도 패수에도 넣지 않습니다.
승률 = 승 ÷ (승+패)로 계산합니다.'
      AND current_row.category IS NOT DISTINCT FROM 'rule'
      AND current_row.source_kind IS NOT DISTINCT FROM 'official_rule'
      AND current_row.source_url IS NOT DISTINCT FROM 'https://6ptotvmi5753.edge.naverncp.com/KBO_FILE/ebook/pdf/2026_%EB%A6%AC%EA%B7%B8%EA%B7%9C%EC%A0%95.pdf#page=13'
      AND current_row.rule_version IS NOT DISTINCT FROM '2026'
      AND current_row.reviewed_at IS NOT DISTINCT FROM '2026-09-11'::date
      AND current_row.aliases IS NOT DISTINCT FROM ARRAY['draw','무']::text[] THEN
    NULL; -- idempotent exact post-state
  ELSIF current_row.term IS NOT DISTINCT FROM '무승부'
      AND current_row.answer IS NOT DISTINCT FROM 'KBO는 연장(정규시즌 12회)까지 동점이면 무승부입니다.
승률 계산에서 무승부는 승수에도 패수에도 넣지 않습니다.
승률 = 승 ÷ (승+패)로 계산합니다.'
      AND current_row.category IS NOT DISTINCT FROM 'rule'
      AND current_row.source_kind IS NOT DISTINCT FROM 'official_rule'
      AND current_row.source_url IS NOT DISTINCT FROM 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx'
      AND current_row.rule_version IS NOT DISTINCT FROM '2026'
      AND current_row.reviewed_at IS NOT DISTINCT FROM '2026-07-30'::date
      AND current_row.aliases IS NOT DISTINCT FROM ARRAY['draw','무']::text[] THEN
    UPDATE public.baseball_terms SET answer = '2026 KBO 리그 규정 기준 연장전은 정규시즌 11회, 포스트시즌 15회까지 진행하며, 그때까지 승패를 가리지 못하면 무승부입니다.
승률 계산에서 무승부는 승수에도 패수에도 넣지 않습니다.
승률 = 승 ÷ (승+패)로 계산합니다.', source_url = 'https://6ptotvmi5753.edge.naverncp.com/KBO_FILE/ebook/pdf/2026_%EB%A6%AC%EA%B7%B8%EA%B7%9C%EC%A0%95.pdf#page=13', reviewed_at = '2026-09-11'::date WHERE term = '무승부';
  ELSE
    RAISE EXCEPTION 'innings glossary drift: 무승부';
  END IF;
  SELECT * INTO current_row FROM public.baseball_terms WHERE term = '연장전' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'innings glossary missing term: 연장전'; END IF;
  IF current_row.term IS NOT DISTINCT FROM '연장전'
      AND current_row.answer IS NOT DISTINCT FROM '9회까지 동점이면 연장전에 들어갑니다.
2026 KBO 리그 규정 기준 연장전은 정규시즌 11회, 포스트시즌 15회까지 진행하며, 그때까지 승패를 가리지 못하면 무승부입니다.'
      AND current_row.category IS NOT DISTINCT FROM 'rule'
      AND current_row.source_kind IS NOT DISTINCT FROM 'official_rule'
      AND current_row.source_url IS NOT DISTINCT FROM 'https://6ptotvmi5753.edge.naverncp.com/KBO_FILE/ebook/pdf/2026_%EB%A6%AC%EA%B7%B8%EA%B7%9C%EC%A0%95.pdf#page=13'
      AND current_row.rule_version IS NOT DISTINCT FROM '2026'
      AND current_row.reviewed_at IS NOT DISTINCT FROM '2026-09-11'::date
      AND current_row.aliases IS NOT DISTINCT FROM ARRAY['연장','extra inning','승부치기']::text[] THEN
    NULL; -- idempotent exact post-state
  ELSIF current_row.term IS NOT DISTINCT FROM '연장전'
      AND current_row.answer IS NOT DISTINCT FROM '9회까지 동점이면 연장전에 들어갑니다.
KBO 정규시즌은 승부치기 없이 12회까지 진행하고, 그래도 동점이면 무승부입니다.'
      AND current_row.category IS NOT DISTINCT FROM 'rule'
      AND current_row.source_kind IS NOT DISTINCT FROM 'official_rule'
      AND current_row.source_url IS NOT DISTINCT FROM 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx'
      AND current_row.rule_version IS NOT DISTINCT FROM '2026'
      AND current_row.reviewed_at IS NOT DISTINCT FROM '2026-07-30'::date
      AND current_row.aliases IS NOT DISTINCT FROM ARRAY['연장','extra inning','승부치기']::text[] THEN
    UPDATE public.baseball_terms SET answer = '9회까지 동점이면 연장전에 들어갑니다.
2026 KBO 리그 규정 기준 연장전은 정규시즌 11회, 포스트시즌 15회까지 진행하며, 그때까지 승패를 가리지 못하면 무승부입니다.', source_url = 'https://6ptotvmi5753.edge.naverncp.com/KBO_FILE/ebook/pdf/2026_%EB%A6%AC%EA%B7%B8%EA%B7%9C%EC%A0%95.pdf#page=13', reviewed_at = '2026-09-11'::date WHERE term = '연장전';
  ELSE
    RAISE EXCEPTION 'innings glossary drift: 연장전';
  END IF;
END
$body$;
COMMIT;
