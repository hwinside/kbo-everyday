-- 9/30 failed definition turns: 보살 / 홈보살.
-- Data coverage only: no routing exceptions and no numeric guard relaxation.
-- 보살: KBO 공식야구규칙 9.10 (보살). 홈보살 is an editorial description
-- of an assist on an out at home, not a separate official scoring category.
-- Existing reviewed rows are never overwritten. Snapshot these two terms before
-- application; rollback may delete ONLY newly inserted IDs whose full values
-- still match this payload. Preserve pre-existing/concurrently edited rows.
INSERT INTO public.baseball_terms
  (term, aliases, answer, category, source_kind, source_url, rule_version, reviewed_at)
VALUES
  ('보살', ARRAY['어시스트'],
   '보살은 송구하거나 타구에 손을 대는 등 수비에 관여하여 다른 야수가 아웃을 잡는 데 도움을 준 야수에게 기록하는 수비 기록입니다. 아웃을 직접 완성한 야수에게 주어지는 자살과 구분합니다.',
   'record', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '9.10', DATE '2026-10-01'),
  ('홈보살', ARRAY['홈 보살'],
   '홈보살은 홈으로 들어오는 주자를 아웃시키는 데 기여한 송구 등의 수비를 가리키는 표현입니다. 외야수가 홈으로 송구해 주자의 득점을 막는 장면에 주로 쓰며, 기록상으로는 보살에 해당합니다. 별도의 공식 기록 항목 이름은 아니지만 실제로 쓰이는 야구 표현입니다.',
   'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-10-01')
ON CONFLICT (term) DO NOTHING;
