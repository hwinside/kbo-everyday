-- Remove only exact reviewed contents; preserve operator edits.
DELETE FROM public.baseball_terms
WHERE term = '포스트시즌'
  AND aliases = ARRAY['포스트 시즌', '가을야구', '가을 야구', 'postseason']::text[]
  AND answer = 'KBO 포스트시즌은 정규시즌 상위 5개 팀이 한국시리즈 우승을 다투는 단계별 경기입니다. 가을야구라고도 부릅니다.
와일드카드 결정전은 정규시즌 4위와 5위가 맞붙습니다. 준플레이오프는 정규시즌 3위와 와일드카드 결정전 승자가 맞붙어 먼저 3승을 거둔 팀이 진출합니다.
플레이오프는 정규시즌 2위와 준플레이오프 승자가 맞붙어 먼저 3승을 거둔 팀이 진출합니다. 한국시리즈는 정규시즌 1위와 플레이오프 승자가 맞붙어 먼저 4승을 거둔 팀이 우승합니다.'
  AND category = 'rule' AND source_kind = 'editorial_definition'
  AND source_url = 'https://6ptotvmi5753.edge.naverncp.com/KBO_FILE/ebook/pdf/2026_%EB%A6%AC%EA%B7%B8%EA%B7%9C%EC%A0%95.pdf'
  AND rule_version = '2026' AND reviewed_at = DATE '2026-11-11';
