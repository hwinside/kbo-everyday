-- Only remove this exact inserted definition after checking the deployment snapshot.
-- Preserve operator edits; do not remove unrelated rows or migration history blindly.
DELETE FROM public.baseball_terms
WHERE term = '4선승제'
  AND aliases = ARRAY['4선승', '사선승제', '7전 4선승제', '7전4선승제']::text[]
  AND answer = '두 팀이 여러 경기를 치러 먼저 4승을 거둔 팀이 시리즈에서 이기는 방식입니다.
4경기를 치른다는 뜻이 아니라, 한 팀이 4번 이겨야 끝난다는 뜻입니다.
무승부는 어느 팀의 승수에도 더하지 않습니다.'
  AND category = 'rule' AND source_kind = 'editorial_definition'
  AND source_url = 'https://6ptotvmi5753.edge.naverncp.com/KBO_FILE/ebook/pdf/2026_%EB%A6%AC%EA%B7%B8%EA%B7%9C%EC%A0%95.pdf'
  AND rule_version = '2026' AND reviewed_at = DATE '2026-11-08';
