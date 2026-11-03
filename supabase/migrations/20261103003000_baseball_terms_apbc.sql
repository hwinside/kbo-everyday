-- Observed production Q3279799 / delivered DM3279800: APBC definition -> unsure.
-- Editorial summary checked against tournament organizer overview, 2026-11-03:
-- https://www.japan-baseball.jp/en/team/topteam/2023/asiachampionships/overview.html
-- Do not freeze edition-specific dates, rosters, eligibility, or results here.
-- No existing rows/cache/jobs are updated. Snapshot before applying; see QA doc.
INSERT INTO public.baseball_terms
  (term, aliases, answer, category, source_kind, source_url, rule_version, reviewed_at)
VALUES
  ('APBC', ARRAY['아시아 프로야구 챔피언십', 'Asia Professional Baseball Championship'],
   'APBC는 Asia Professional Baseball Championship의 약자로, 아시아 프로야구 챔피언십을 뜻합니다. 젊은 프로 선수들이 중심이 되는 국가·지역 대표팀 간 국제 야구 대회입니다.',
   'basic', 'editorial_definition', 'https://www.japan-baseball.jp/en/team/topteam/2023/asiachampionships/overview.html', 'not_applicable', DATE '2026-11-03')
ON CONFLICT (term) DO NOTHING;
