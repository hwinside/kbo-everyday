-- ============================================================
-- 검수 사전 1차 로그 기반 확장 (2026-08-16)
--
-- 근거: `genius_question_logs` 최근 72시간 전수조사 1,072건 / 유저 320명.
--   답변 불가 325건(30.3%) 중 **최대 유형이 `용어·룰 단문(사전 미수록)` 117건(36.0%)** 이었다.
--   사전은 production 136항목뿐이라, 유저가 실제로 물어본 기본 용어(잔루·타수·타석·실점·만루·
--   전광판 B/S/O·포지션명)가 통째로 비어 `unsure`/`blocked` 로 종결됐다.
--
-- 🔴 행 수 SSOT (삼순 2026-08-16 NO-GO — 136/132/164 3중 불일치의 정체):
--   production 136 = repo seed 132 + **repo 에 INSERT 가 없는 4행**(`10-10`~`40-40 클럽`).
--   그 4행은 2026-08-11 production 에 직접 들어갔고 repo 에는 톤 migration 의 UPDATE 대상으로만
--   존재해, 신규 환경 재구축본(132)과 production(136)이 영구히 어긋나 있었다.
--   이 배치가 ⓐ 블록으로 그 4행을 정본화해 **양쪽이 164 로 수렴**한다:
--     재구축본  132 + 4(정본화) + 28(신규) = 164
--     production 136 + 0(ON CONFLICT no-op) + 28(신규) = 164
--
-- ⚠️ 이 배치는 **룰(코드) 추가가 아니라 데이터 행 추가**다. 판정 로직은 한 줄도 바뀌지 않고,
--   `matchGlossary` 가 쓰는 닫힌 집합의 원소만 늘어난다(핑퐁 축 아님).
--
-- ⚠️ 수록 기준: 실제 운영 로그에 **질문으로 등장한** 용어만 넣는다. 로그에 있어도 뜻을 확정할
--   수 없는 팬 은어(`어저미`·`도니살`·`콱`·`케어러쉬`·`투출유`)는 **넣지 않는다** — 지어낸
--   정의를 사전에 박으면 그 오답이 캐시·RAG 를 거쳐 영구화된다.
--
-- 톤: 전 답변 합니다체(2026-08-14 톤 SSOT). 게이트가 `isBaseballGeniusToneCompliant` 로 검증한다.
-- 멱등: ON CONFLICT (term) DO NOTHING — 재실행해도 기존 행을 덮어쓰지 않는다.
-- ============================================================

-- ── ⓐ Production 선존재 4행 정본화 + 계약 위반 교정 (삼순 2026-08-16 2차 NO-GO) ──
--
-- 🔴 실측: 이 4행은 **repo migration 어디에도 INSERT 가 없다.**
--   `created_at = 2026-08-11 00:58:28+00` 로 production 에 직접 들어갔고,
--   repo 에는 `20260814121000_baseball_terms_formal_tone.sql` 의 **UPDATE 대상**으로만
--   등장한다(그 migration 은 INSERT 를 하지 않는다).
--   → 재구축본 132 vs production 136. 수치 혼선(136/132/164)의 정체가 이것이다.
--
-- 🔴 그리고 이 4행은 근거 분류 계약을 어기고 있다 —
--   `editorial_definition` 인데 `rule_version = '2026'`(계약상 `not_applicable`).
--   repo INSERT 가 없어 게이트를 한 번도 안 탔기 때문이다.
--
--   ⚠️ 종전 판(1차 반영)에서는 "지금 고치면 재구축본과 production 이 갈린다"며 위반값을
--     그대로 넣었는데, **그 전제가 틀렸다**(삼순 지적). `ON CONFLICT DO NOTHING` 이라
--     production 은 손대지 않으니 오히려 **영구히 갈린 채로 고정**되고, 알려진 계약 위반을
--     fresh DB 에 새로 심는 꼴이었다.
--   → 아래처럼 **양쪽을 동시에 교정**한다:
--       INSERT ... ON CONFLICT (term) DO UPDATE  (재구축본: 계약 준수값으로 생성)
--       WHERE 절 CAS                              (production: 알려진 위반값일 때만 교정)
--   CAS 조건이 answer 를 건드리지 않으므로 2026-08-14 톤 migration 결과는 보존된다.
INSERT INTO public.baseball_terms(term, aliases, answer, category, source_kind, source_url, rule_version, reviewed_at)
VALUES
('10-10 클럽', ARRAY['10-10','10-10클럽','텐텐클럽','텐텐 클럽'],
 '한 시즌에 홈런 10개와 도루 10개를 동시에 달성하는 기록입니다.
장타력과 기동력을 모두 갖춘 선수라는 뜻입니다.
호타준족의 입문 코스로 불립니다.',
 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-11'),

('20-20 클럽', ARRAY['20-20','20-20클럽','트웬티트웬티클럽'],
 '한 시즌에 홈런 20개와 도루 20개를 동시에 달성하는 기록입니다.
파워와 스피드를 겸비한 호타준족의 상징입니다.
KBO에서도 시즌마다 쉽게 나오지 않는 기록입니다.',
 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-11'),

('30-30 클럽', ARRAY['30-30','30-30클럽','서티서티클럽'],
 '한 시즌에 홈런 30개와 도루 30개를 동시에 달성하는 대기록입니다.
KBO 최초는 1996년 박재홍 선수입니다.
리그를 대표하는 호타준족만 도달할 수 있습니다.',
 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-11'),

('40-40 클럽', ARRAY['40-40','40-40클럽','포티포티클럽'],
 '한 시즌에 홈런 40개와 도루 40개를 동시에 달성하는 초대형 기록입니다.
KBO에서는 2015년 에릭 테임즈 선수가 최초이자 유일하게 달성했습니다.
세계적으로도 극소수만 도달한 꿈의 기록입니다.',
 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-11')
ON CONFLICT (term) DO UPDATE
   SET rule_version = EXCLUDED.rule_version
 WHERE baseball_terms.source_kind = 'editorial_definition'
   AND baseball_terms.source_url IS NULL
   AND baseball_terms.rule_version = '2026'
   -- ⚠️ answer 는 **비교도 갱신도 하지 않는다** — 톤 migration(20260814121000) 결과를
   --   되돌리면 안 되고, 이 교정의 대상은 metadata 한 칸(rule_version)뿐이다.
   AND baseball_terms.answer = EXCLUDED.answer;

INSERT INTO public.baseball_terms(term, aliases, answer, category, source_kind, source_url, rule_version, reviewed_at)
VALUES
-- ── 포지션 (로그: `내야수가 뭐야` `1루수` `2루수는`) ─────────────────────────────
('내야수', ARRAY['내야','infielder','내야 수비','내야진'],
 '1루수·2루수·3루수·유격수를 묶어 부르는 수비 포지션입니다.
투수와 포수를 제외한 다이아몬드 안쪽 수비를 맡습니다.
땅볼 처리와 병살 연결이 주된 임무입니다.',
 'position', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-16'),

('외야수', ARRAY['외야','outfielder','외야 수비','외야진'],
 '좌익수·중견수·우익수를 묶어 부르는 수비 포지션입니다.
내야를 넘어간 타구를 처리하고 주자 진루를 막습니다.
넓은 수비 범위와 송구 능력이 중요합니다.',
 'position', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-16'),

('1루수', ARRAY['일루수','first baseman','1b','퍼스트'],
 '1루 베이스를 지키는 내야 수비 포지션입니다.
다른 야수의 송구를 받아 타자 주자를 아웃시키는 역할이 가장 많습니다.
포구 안정감이 특히 중요한 자리입니다.',
 'position', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-16'),

('2루수', ARRAY['이루수','second baseman','2b','세컨'],
 '1루와 2루 사이를 지키는 내야 수비 포지션입니다.
유격수와 짝을 이뤄 병살 플레이의 중심이 됩니다.
빠른 송구 전환과 넓은 수비 범위가 필요합니다.',
 'position', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-16'),

('3루수', ARRAY['삼루수','third baseman','3b','핫코너'],
 '3루 베이스를 지키는 내야 수비 포지션입니다.
강한 타구가 짧은 거리에서 오기 때문에 핫코너라고 불립니다.
순발력과 강한 송구가 요구됩니다.',
 'position', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-16'),

('중견수', ARRAY['센터','center fielder','cf','중견'],
 '외야 한가운데를 지키는 수비 포지션입니다.
외야에서 담당 범위가 가장 넓습니다.
타구 판단과 발이 가장 중요한 자리입니다.',
 'position', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-16'),

('좌익수', ARRAY['레프트','left fielder','lf','좌익'],
 '외야 왼쪽을 지키는 수비 포지션입니다.
우타자의 당겨친 타구가 많이 오는 자리입니다.
외야 중에서는 송구 부담이 비교적 적습니다.',
 'position', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-16'),

('우익수', ARRAY['라이트','right fielder','rf','우익'],
 '외야 오른쪽을 지키는 수비 포지션입니다.
3루까지 거리가 멀어 외야 중 가장 강한 어깨가 필요합니다.
좌타자의 당겨친 타구가 많이 옵니다.',
 'position', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-16'),

-- ── 기록 (로그: `타수가 뭐야` `잔루` `실점이 뭐야` `피안타` `바빕이 뭐야`) ───────────
('타석', ARRAY['plate appearance','pa','타석수','타석이란'],
 '타자가 타순이 돌아와 타격을 마친 횟수 전체입니다.
볼넷·몸에 맞는 공·희생번트·희생플라이도 모두 타석에 포함됩니다.
규정 타석을 채워야 타율 순위에 오를 수 있습니다.',
 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-16'),

('타수', ARRAY['at bat','ab','타수란','타수가'],
 '타율을 계산할 때 분모가 되는 횟수입니다.
타석 중 볼넷·몸에 맞는 공·희생번트·희생플라이는 타수에서 뺍니다.
타율은 안타를 타수로 나눠 계산합니다.',
 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-16'),

('잔루', ARRAY['lob','left on base','잔루만루','루상잔루','잔루수'],
 '이닝이나 경기가 끝날 때 베이스에 남은 주자 수입니다.
득점 기회를 살리지 못했다는 뜻으로 읽습니다.
팀 잔루가 많으면 결정력이 아쉬웠다고 평가합니다.',
 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-16'),

('사사구', ARRAY['사사구란','四死球','볼넷과 몸에 맞는 공'],
 '볼넷(四球)과 몸에 맞는 공(死球)을 합쳐 부르는 말입니다.
볼넷은 볼 네 개, 몸에 맞는 공은 투구가 타자 몸에 맞은 경우입니다.
둘 다 타자가 아웃 없이 1루로 걸어 나갑니다.',
 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/PitcherBasic/Basic2.aspx', '2026', DATE '2026-08-16'),

('피안타', ARRAY['피안타수','hits allowed','피안타율','피안타가'],
 '투수가 상대 타자에게 허용한 안타입니다.
피안타율은 그 투수를 상대한 타자들의 타율에 해당합니다.
적을수록 좋은 투수 지표입니다.',
 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/PitcherBasic/Basic1.aspx', '2026', DATE '2026-08-16'),

('BABIP', ARRAY['바빕','babip','인플레이타구타율','인플레이 타구 타율'],
 '홈런을 제외한 인플레이 타구가 안타가 된 비율입니다.
리그 평균은 대체로 0.300 안팎에서 형성됩니다.
표본이 적을 때는 운의 영향이 커서 크게 흔들립니다.',
 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-16'),

('피OPS', ARRAY['피ops','opponent ops','피오피에스'],
 '투수가 상대한 타자들의 OPS입니다.
출루와 장타를 함께 얼마나 내줬는지 한 번에 보여 줍니다.
낮을수록 상대 타선을 잘 억제했다는 뜻입니다.',
 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-16'),

('커리어하이', ARRAY['커리어 하이','career high','개인 최고 기록'],
 '선수가 커리어 전체에서 남긴 개인 최고 성적입니다.
보통 한 시즌 기준으로 이야기합니다.
어떤 지표 기준인지 함께 말해야 뜻이 분명해집니다.',
 'culture', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-16'),

-- ── 투구 (로그: `와인드업이 뭐야` `1회초 4실점은 뭔말이야`) ─────────────────────
('실점', ARRAY['runs allowed','실점이란','실점이','총실점'],
 '투수가 책임지는 주자가 득점해 내준 점수입니다.
자기가 내보낸 주자가 교체 뒤에 득점해도 앞 투수의 실점입니다.
이 가운데 수비 실책 등이 원인이 아닌 점수만 자책점으로 칩니다.',
 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/PitcherBasic/Basic1.aspx', '2026', DATE '2026-08-16'),

('와인드업', ARRAY['windup','wind up','와인드업 자세','와인드업 투구'],
 '주자가 없을 때 크게 반동을 주면서 던지는 투구 자세입니다.
힘을 싣기 좋지만 동작이 커서 도루를 내주기 쉽습니다.
주자가 나가면 보통 동작이 짧은 세트 포지션으로 바꿉니다.',
 'pitching', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-16'),

-- ── 타격 (로그: `백투백` `루킹삼진` `그라운드 홈런은?` `1루타랑 안타랑 뭐가 달라`) ──
('1루타', ARRAY['단타','single','싱글','일루타'],
 '타자가 1루까지만 진루한 안타입니다.
안타 중 가장 자주 나오는 형태입니다.
장타율 계산에서는 1점으로 칩니다.',
 'batting', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-16'),

('백투백', ARRAY['백 투 백','back to back','연속타자홈런','백투백홈런'],
 '두 타자가 연달아 홈런을 치는 것입니다.
세 타자가 연달아 치면 백투백투백이라고 부릅니다.
상대 투수에게는 흐름이 크게 흔들리는 장면입니다.',
 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-16'),

('루킹삼진', ARRAY['루킹 삼진','스탠딩삼진','called strikeout','서서삼진','스탠딩 삼진'],
 '타자가 배트를 내지 않고 선 채로 당하는 삼진입니다.
마지막 공이 스트라이크로 판정되면서 아웃됩니다.
헛스윙 삼진과 구분해 부르는 말입니다.',
 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-16'),

('그라운드홈런', ARRAY['그라운드 홈런','인사이드파크홈런','inside the park home run','장내홈런'],
 '담장을 넘기지 않고 그라운드 안에서 홈까지 들어와 성립하는 홈런입니다.
타구가 외야에서 크게 튀거나 수비가 처리하지 못했을 때 나옵니다.
기록에서는 담장을 넘긴 홈런과 똑같이 인정합니다.',
 'batting', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-16'),

-- ── 규칙 (로그: `3피트룰` `파울 타구가 폴대를 맞추면 홈런이야?` `만루`) ────────────
('3피트룰', ARRAY['3피트 룰','쓰리피트','three foot rule','3피트 라인','스리피트'],
 '타자 주자가 1루로 달릴 때 파울 라인 바깥 3피트 폭 안으로 달려야 하는 규칙입니다.
이 범위를 벗어나 1루 송구나 포구를 방해하면 아웃이 선언될 수 있습니다.
홈과 1루 사이의 뒤쪽 절반 구간에 적용합니다.',
 'rule', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-16'),

('파울폴', ARRAY['폴대','파울폴대','foul pole','파울 폴','폴'],
 '좌우 담장 끝에 세워 페어와 파울을 가르는 기둥입니다.
타구가 폴대를 직접 맞히면 홈런으로 인정합니다.
이름과 달리 폴대 자체는 페어 지역에 속합니다.',
 'rule', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-16'),

('만루', ARRAY['bases loaded','만루상황','만루 상황','풀베이스'],
 '1루·2루·3루에 모두 주자가 나가 있는 상황입니다.
안타 하나로 여러 점이 날 수 있는 최대 득점 기회입니다.
이때 나온 홈런이 만루홈런입니다.',
 'rule', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-16'),

-- ── 관전 (로그: `그 전광판에 B S O 이게 뭐야` `RHEB 가 뭐야` `전광판 보는법 알려줘`) ──
('전광판', ARRAY['스코어보드','scoreboard','전광판 보는 법','전광판 보는법','bso','rheb','b s o'],
 '전광판에는 이닝별 점수와 함께 R·H·E·B 가 표시됩니다.
R 은 득점, H 는 안타, E 는 실책, B 는 볼넷을 뜻합니다.
B·S·O 칸은 각각 현재 타석의 볼·스트라이크·아웃 카운트입니다.',
 'basic', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-16'),

-- ── 문화 (로그: `영구결번` `상무` `윤도현이랑 정해영이 가는 상무`) ─────────────────
('영구결번', ARRAY['영구 결번','retired number','등번호 영구결번'],
 '구단이 특정 선수의 등번호를 더 이상 쓰지 않기로 정하는 예우입니다.
구단 역사에 큰 발자취를 남긴 선수에게 부여합니다.
선정 기준은 KBO 각 구단이 자체적으로 정합니다.',
 'culture', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-16'),

('상무', ARRAY['상무야구단','국군체육부대','상무 피닉스','상무피닉스'],
 '군 복무를 하면서 야구를 계속할 수 있는 국군체육부대 소속 야구단입니다.
퓨처스리그에 참가해 경기를 치릅니다.
지원해서 선발 전형에 합격해야 입대할 수 있습니다.',
 'culture', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-16')
ON CONFLICT (term) DO NOTHING;

-- ── 기존 항목 alias 보강 ──────────────────────────────────────────────────────
-- 로그에 실제로 등장한 표기인데 exact 매칭에서 미스한 것들만. answer 는 건드리지 않는다
-- (2026-08-14 톤 migration 의 CAS 대상은 `answer` 이므로 alias 추가는 그 계약과 무관하다).
-- 멱등: 이미 있으면 배열에 다시 넣지 않는다.
UPDATE public.baseball_terms
   SET aliases = aliases || ARRAY['삼진아웃','삼진 아웃']
 WHERE term = '삼진' AND NOT (aliases @> ARRAY['삼진아웃']);

UPDATE public.baseball_terms
   SET aliases = aliases || ARRAY['볼펜']
 WHERE term = '불펜' AND NOT (aliases @> ARRAY['볼펜']);

UPDATE public.baseball_terms
   SET aliases = aliases || ARRAY['라인드라이브','라인드라이브아웃','라인드라이브 아웃','line drive']
 WHERE term = '직선타' AND NOT (aliases @> ARRAY['라인드라이브아웃']);

UPDATE public.baseball_terms
   SET aliases = aliases || ARRAY['파울팁삼진','파울팁 삼진']
 WHERE term = '파울팁' AND NOT (aliases @> ARRAY['파울팁삼진']);
