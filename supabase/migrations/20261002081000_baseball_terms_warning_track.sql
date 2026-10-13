-- #1513 R10: reviewed glossary coverage, not a correction exception list.
-- Editorial definition; this is not an official KBO rule/dimension claim.
-- Terminology reference checked 2026-10-02:
-- https://ko.wikipedia.org/wiki/워닝_트랙
-- Pre-apply snapshot must include matching names/aliases. Preserve existing rows.
-- Rollback only the newly inserted ID while its complete payload still matches.
INSERT INTO public.baseball_terms
  (term, aliases, answer, category, source_kind, source_url, rule_version, reviewed_at)
VALUES
  ('워닝 트랙', ARRAY['워닝트랙', 'warning track'],
   '워닝 트랙은 야구장 펜스 바로 앞에 경기 구역과 다른 재질로 만든 구역입니다. 타구를 보며 달리는 수비수가 발밑의 재질 변화를 통해 펜스에 가까워졌음을 알아차리도록 돕습니다.',
   'basic', 'editorial_definition', NULL, 'not_applicable', DATE '2026-10-02')
ON CONFLICT (term) DO NOTHING;
