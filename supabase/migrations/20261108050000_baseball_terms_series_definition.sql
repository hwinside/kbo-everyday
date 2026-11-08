-- One missing definition, not a change to competition format or current series scores.
-- Explain first-to-four wins; never claim a fixed number of actual games with ties.
INSERT INTO public.baseball_terms
  (term, aliases, answer, category, source_kind, source_url, rule_version, reviewed_at)
VALUES
  ('4선승제', ARRAY['4선승', '사선승제', '7전 4선승제', '7전4선승제'],
   '두 팀이 여러 경기를 치러 먼저 4승을 거둔 팀이 시리즈에서 이기는 방식입니다.
4경기를 치른다는 뜻이 아니라, 한 팀이 4번 이겨야 끝난다는 뜻입니다.
무승부는 어느 팀의 승수에도 더하지 않습니다.',
   'rule', 'editorial_definition', 'https://6ptotvmi5753.edge.naverncp.com/KBO_FILE/ebook/pdf/2026_%EB%A6%AC%EA%B7%B8%EA%B7%9C%EC%A0%95.pdf', '2026', DATE '2026-11-08')
ON CONFLICT (term) DO NOTHING;
