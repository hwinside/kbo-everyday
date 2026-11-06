-- Observed: RBI definition mentions this term, but its follow-up definition is absent.
-- 2026 KBO Official Baseball Rules 5.05(b)(1), 5.06(b)(3)(B), 9.04(a).
-- Add one reviewed definition; do not conflate HBP, balks, or scoring records.
-- Existing rows and completed messages are untouched. Snapshot before application.
INSERT INTO public.baseball_terms
  (term, aliases, answer, category, source_kind, source_url, rule_version, reviewed_at)
VALUES
  ('밀어내기 볼넷', ARRAY['밀어내기볼넷', '밀어내기 포볼'],
   '만루에서 타자가 볼넷으로 1루에 나가면서 모든 주자가 한 베이스씩 밀려나고, 3루 주자가 홈을 밟아 득점하는 것을 밀어내기 볼넷이라고 합니다.
타자에게 타점이 기록됩니다.
만루가 아니라면 볼넷만으로 3루 주자에게 홈까지의 안전진루권이 생기는 것은 아닙니다.',
   'rule', 'official_rule', 'https://6ptotvmi5753.edge.naverncp.com/KBO_FILE/ebook/pdf/2026_야구규칙.pdf', '2026', DATE '2026-11-06')
ON CONFLICT (term) DO NOTHING;
