-- ============================================================
-- 야잘알봇 검수 사전 확충 1차 (2026-08-05)
--
-- 근거: 운영 미답변 로그 1,075건 중 TERM 라벨 479건을 실측한 결과,
--       현재 사전 132종 + 기존 정규화로는 476건이 미매칭이었다.
--       (3건만 정규화로 잡혔고 나머지는 사전에 아예 없거나 표기가 달랐다)
--
-- 이 migration 이 하는 일:
--   ① 신규 용어 61종 삽입
--   ② 기존 용어에 alias 73건 보강 (오타·약어·구어 표기)
--   ③ 신규 term 과 정규화 키가 충돌하는 기존 alias 8건 제거
--
-- ③이 필요한 이유: matchGlossary 는 Map 에 먼저 들어간 항목이 이기고 뒤엣것은
-- 조용히 가려진다(에러 없음). 예) 신규 term '직구' vs 기존 '포심'의 alias '직구'.
-- 분리해서 답해야 하는 개념은 기존 alias 에서 명시적으로 뺀다.
--
-- ⚠️ 기존 answer 는 절대 덮지 않는다 (삼순 2026-08-05 NO-GO).
--    ①의 INSERT 는 `ON CONFLICT DO UPDATE` 를 쓰되 **answer 는 갱신 대상에서 제외**하고,
--    갱신 자체도 `WHERE baseball_terms.reviewed_at = '<이 확충의 날짜>'` 로 제한한다.
--    즉 이 migration 이 만든 행만 자기 자신을 재적용할 수 있고(멱등),
--    사람이 먼저 검수해 둔 기존 행은 alias 조차 이 경로로 바뀌지 않는다.
--    기존 행에 붙일 alias 는 ②에서 **합집합**으로만 더한다(파괴 없음).
--
-- 멱등: 재실행해도 결과 동일 (②는 DISTINCT 합집합, ③은 조건부 삭제).
-- ============================================================

BEGIN;

-- ③ 충돌 alias 제거 (신규 term 삽입 전에 수행해야 가림 현상이 안 생긴다)
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT a FROM unnest(aliases) AS a WHERE a <> ALL (ARRAY['루징시리즈']::text[]))
  WHERE term = '위닝시리즈';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT a FROM unnest(aliases) AS a WHERE a <> ALL (ARRAY['라인업','오더']::text[]))
  WHERE term = '타순';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT a FROM unnest(aliases) AS a WHERE a <> ALL (ARRAY['희생타']::text[]))
  WHERE term = '희생플라이';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT a FROM unnest(aliases) AS a WHERE a <> ALL (ARRAY['비자책']::text[]))
  WHERE term = '자책점';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT a FROM unnest(aliases) AS a WHERE a <> ALL (ARRAY['빈볼']::text[]))
  WHERE term = '몸에 맞는 공';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT a FROM unnest(aliases) AS a WHERE a <> ALL (ARRAY['경쟁균형세']::text[]))
  WHERE term = '샐러리캡';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT a FROM unnest(aliases) AS a WHERE a <> ALL (ARRAY['스플리터','스플릿','splitter']::text[]))
  WHERE term = '포크볼';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT a FROM unnest(aliases) AS a WHERE a <> ALL (ARRAY['병살','더블플레이','dp','더블 플레이','겟투']::text[]))
  WHERE term = '병살타';

-- ① 신규 용어
INSERT INTO public.baseball_terms (term, aliases, answer, category, source_kind, source_url, rule_version, reviewed_at)
VALUES
  ('적시타', ARRAY['타점타','타점 안타','rbi 안타','적시안타']::text[], '주자가 있을 때 안타를 쳐서 그 주자를 홈으로 불러들인 안타예요.
타점(RBI)이 기록돼요.
2점을 불러들이면 2타점 적시타라고 불러요.', 'batting', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('타수', ARRAY['ab','at bat','타수가']::text[], '타율을 계산할 때 분모가 되는 숫자예요.
타석 중에서 볼넷·몸에 맞는 공·희생번트·희생플라이는 타수에서 빠져요.
타율 = 안타 ÷ 타수예요.', 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('타석', ARRAY['pa','plate appearance','타석수']::text[], '타자가 타자석에 들어서서 한 번의 결과가 나올 때까지를 말해요.
볼넷·사구·희생타도 모두 타석에 포함돼요.
타수보다 넓은 개념이에요.', 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('볼카운트', ARRAY['카운트','count','볼 카운트']::text[], '지금 타석의 볼과 스트라이크 개수예요.
보통 ''볼-스트라이크'' 순서로 2-1처럼 읽어요.
볼 4개면 볼넷, 스트라이크 3개면 삼진이에요.', 'basic', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('헛스윙', ARRAY['헛 스윙','swing and miss','헛스윙이']::text[], '타자가 방망이를 휘둘렀는데 공을 맞히지 못한 거예요.
존을 벗어난 공이어도 헛스윙하면 스트라이크예요.
3개째면 헛스윙 삼진이에요.', 'basic', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('1루타', ARRAY['일루타','single','단타']::text[], '타자가 안타를 치고 1루까지만 나간 거예요.
가장 기본이 되는 안타예요.
기록지에는 안타(H)로 함께 집계돼요.', 'batting', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('인사이드더파크홈런', ARRAY['인사이드 더 파크 홈런','러닝홈런','그라운드홈런','장내홈런']::text[], '타구가 담장을 넘지 않았는데 타자가 **수비 실책 없이** 홈까지 달려 들어온 홈런이에요.
실책 덕에 홈에 들어오면 홈런이 아니라 안타와 실책으로 기록돼요.
러닝홈런이라고도 불러요.', 'batting', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('쓰리번트', ARRAY['스리번트','3번트','투스트라이크 번트']::text[], '2스트라이크에서 시도하는 번트예요.
이때 번트한 공이 파울이 되면 곧바로 삼진 아웃이에요.
그래서 위험 부담이 큰 작전이에요.', 'rule', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('페어', ARRAY['페어볼','페어 볼','페어지역','페어 지역']::text[], '타구가 1루선과 3루선 안쪽(페어 지역)에 들어온 걸 말해요.
페어면 경기가 계속되고 타자는 뛰어야 해요.
선 바깥으로 나가면 파울이에요.', 'rule', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('BABIP', ARRAY['babip','바빕','인플레이 타구 타율','bapip']::text[], '홈런과 삼진을 뺀, 그라운드 안으로 들어간 타구가 안타가 된 비율이에요.
운의 영향을 크게 받아 평균(약 .300)에서 크게 벗어나면 되돌아오는 경향이 있어요.', 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('wOBA', ARRAY['woba','워바','가중 출루율','가중출루율']::text[], '볼넷·단타·2루타·홈런에 각각 다른 가치를 매겨 더한 타격 지표예요.
출루율과 비슷한 눈금이라 .400이면 아주 좋은 편이에요.
세이버매트릭스 지표예요.', 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('ISO', ARRAY['iso','순장타율','아이소']::text[], '장타율에서 타율을 뺀 값으로, 순수한 장타력을 보는 지표예요.
단타를 걷어내고 얼마나 멀리 치는지만 남겨요.
.200을 넘으면 거포로 봐요.', 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('K/9', ARRAY['k/9','k9','9이닝당 탈삼진']::text[], '투수가 9이닝을 던진다고 가정했을 때 잡는 삼진 개수예요.
숫자가 높을수록 탈삼진 능력이 좋아요.
9를 넘으면 상위권으로 봐요.', 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('BB/9', ARRAY['bb/9','bb9','9이닝당 볼넷']::text[], '투수가 9이닝당 내주는 볼넷 개수예요.
낮을수록 제구가 안정적이라는 뜻이에요.
3 아래면 좋은 편으로 봐요.', 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('K/BB', ARRAY['k/bb','kbb','삼진 볼넷 비율']::text[], '탈삼진을 볼넷으로 나눈 값이에요.
삼진은 많고 볼넷은 적을수록 높아져요.
투수의 제구와 위력을 한 번에 보는 지표예요.', 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('FIP', ARRAY['fip','수비무관 평균자책점','핍']::text[], '수비의 영향을 뺀 평균자책점이에요.
삼진·볼넷·몸에 맞는 공·홈런만으로 계산해요.
평균자책점과 눈금이 비슷해 함께 놓고 비교해요.', 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('ERA+', ARRAY['era+','조정 평균자책점','이알에이 플러스']::text[], '리그 평균과 구장 효과를 반영해 평균자책점을 100 기준으로 바꾼 지표예요.
100이 평균이고, 150이면 평균보다 크게 좋다는 뜻이에요.', 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('OPS+', ARRAY['ops+','조정 ops']::text[], '리그 평균과 구장 효과를 반영해 OPS를 100 기준으로 바꾼 지표예요.
100이 평균, 130이면 평균보다 30% 좋다는 뜻이에요.', 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('QS+', ARRAY['qs+','퀄리티스타트 플러스','퀄리티 스타트 플러스','퀄스플','퀄스쁠','퀄수플']::text[], '선발투수가 7이닝 이상을 던지고 자책점 3점 이하로 막은 경기예요.
6이닝·3자책 이하인 퀄리티스타트보다 한 단계 높은 기준이에요.', 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('실점', ARRAY['실점이','runs allowed']::text[], '투수가 책임지는 주자가 홈에 들어와 준 점수예요.
교체된 뒤라도 자기가 내보낸 주자가 득점하면 그 점수는 전임 투수에게 붙어요.
이 중 수비 실책 등으로 난 점수를 빼면 자책점이에요.', 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('피안타', ARRAY['피 안타','맞은 안타']::text[], '투수가 상대 타자에게 맞은 안타예요.
투수 기록에서는 ''피''를 붙여 피안타·피홈런처럼 불러요.
적을수록 좋은 기록이에요.', 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('피홈런', ARRAY['피 홈런','맞은 홈런','탈홈런']::text[], '투수가 상대에게 맞은 홈런이에요.
한 번에 여러 점을 주기 때문에 투수에게 가장 아픈 기록이에요.
일부 팬은 농담처럼 ''탈홈런''이라고 부르기도 해요.', 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('게임차', ARRAY['게임 차','승차','게임차가','경기차']::text[], '순위표에서 두 팀의 승패 차이를 나타내는 값이에요.
(위 팀 승 - 아래 팀 승)과 (아래 팀 패 - 위 팀 패)를 더해 2로 나눠요.
0.5면 반 경기 차예요.', 'league', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('보살', ARRAY['보살이','어시스트','assist']::text[], '수비수가 아웃을 만드는 과정에서 공을 던져 도운 기록이에요.
직접 아웃을 잡으면 자살(풋아웃), 도우면 보살이에요.
유격수·2루수에게 많이 쌓여요.', 'defense', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('포지션 번호', ARRAY['수비 위치 번호','수비수 번호','포지션번호','수비위치번호','포지션 넘버']::text[], '기록지에서 수비 위치를 숫자로 적는 방식이에요.
1 투수, 2 포수, 3 1루수, 4 2루수, 5 3루수, 6 유격수, 7 좌익수, 8 중견수, 9 우익수예요.', 'position', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('6-4-3 병살', ARRAY['643 병살','6-4-3','643','643 더블플레이']::text[], '공이 지나간 수비 위치를 번호로 적은 거예요.
6은 유격수, 4는 2루수, 3은 1루수라서 ''유격수→2루수→1루수'' 병살이라는 뜻이에요.', 'defense', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('투수', ARRAY['pitcher','p','투수가']::text[], '마운드에서 타자에게 공을 던지는 선수예요.
수비 위치 번호는 1번이에요.
경기 시작을 맡는 선발과 뒤를 이어 던지는 불펜으로 나뉘어요.', 'position', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('1루수', ARRAY['일루수','1b','퍼스트']::text[], '1루를 지키는 수비수예요.
수비 위치 번호는 3번이에요.
다른 야수가 던진 공을 받아 타자 주자를 아웃시키는 역할이 많아요.', 'position', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('2루수', ARRAY['이루수','세컨','세컨드베이스맨']::text[], '1루와 2루 사이를 지키는 수비수예요.
수비 위치 번호는 4번이에요.
유격수와 짝을 이뤄 병살 플레이를 만들어요.', 'position', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('3루수', ARRAY['삼루수','서드','핫코너']::text[], '3루를 지키는 수비수예요.
수비 위치 번호는 5번이에요.
강한 타구가 빠르게 오는 자리라 ''핫코너''라고도 불러요.', 'position', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('좌익수', ARRAY['레프트','lf','좌익수가']::text[], '외야 왼쪽을 지키는 수비수예요.
수비 위치 번호는 7번이에요.
타자 기준으로 3루 쪽 바깥 잔디를 맡아요.', 'position', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('중견수', ARRAY['센터','cf','중견수가']::text[], '외야 한가운데를 지키는 수비수예요.
수비 위치 번호는 8번이에요.
담당 범위가 가장 넓어서 발과 수비 범위가 중요한 자리예요.', 'position', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('우익수', ARRAY['라이트','rf','우익수가']::text[], '외야 오른쪽을 지키는 수비수예요.
수비 위치 번호는 9번이에요.
3루까지 던져야 하는 상황이 많아 어깨가 강한 선수가 맡아요.', 'position', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('내야수', ARRAY['인필더','infielder']::text[], '1루수·2루수·3루수·유격수처럼 흙이 깔린 안쪽을 지키는 수비수예요.
타구 처리와 병살 플레이를 주로 맡아요.
바깥 잔디를 맡으면 외야수예요.', 'position', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('외야수', ARRAY['아웃필더','outfielder']::text[], '좌익수·중견수·우익수처럼 잔디 바깥쪽을 지키는 수비수예요.
뜬공을 잡고 담장까지 가는 타구를 막아요.
안쪽 흙 지역을 맡으면 내야수예요.', 'position', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('야수', ARRAY['필더','fielder','야수는']::text[], '투수를 뺀 나머지 수비 선수를 통틀어 부르는 말이에요.
포수·내야수·외야수가 모두 야수예요.
타격 기록을 이야기할 때 투수와 구분하는 표현이기도 해요.', 'position', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('홈스틸', ARRAY['홈 스틸','홈 도루','홈스틸이']::text[], '3루 주자가 홈으로 도루해 득점하는 거예요.
성공하기 아주 어려워서 한 시즌에 몇 번 볼까 말까 해요.
기록은 도루로 인정돼요.', 'running', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('잔루', ARRAY['잔루가','lob','남은 주자']::text[], '이닝이 끝났을 때 베이스에 남아 있던 주자예요.
득점 기회를 살리지 못했다는 뜻이라 아쉬움이 큰 기록이에요.
영어로는 LOB이라고 적어요.', 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('만루', ARRAY['만루가','베이스 로디드','풀 베이스']::text[], '1루·2루·3루에 주자가 모두 있는 상황이에요.
안타 하나로 여러 점이 나고, 홈런이면 만루홈런 4점이에요.
수비는 어디로 던져도 포스아웃이 가능해요.', 'basic', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('무사', ARRAY['노아웃','무사가','0아웃']::text[], '그 이닝에 아웃이 아직 하나도 없는 상황이에요.
아웃 1개면 1사, 2개면 2사라고 불러요.
''무사 만루''는 아웃 없이 주자가 꽉 찬 최고의 찬스예요.', 'basic', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('1사', ARRAY['원아웃','1아웃','일사']::text[], '그 이닝에 아웃이 1개 나온 상황을 1사, 2개면 2사라고 해요.
아직 없으면 무사예요.
아웃 3개가 되면 공수가 바뀌어요.', 'basic', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('유령주자', ARRAY['유령 주자','승부치기 주자','고스트러너']::text[], '승부치기에서 이닝 시작 때 안타 없이 미리 베이스에 놓아두는 주자예요.
KBO 정규시즌에는 쓰지 않고, 승부치기를 적용하는 대회에서 사용해요.', 'rule', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('고의낙구', ARRAY['고의 낙구','고의낙구가','일부러 떨어뜨리기']::text[], '야수가 병살을 노리고 잡을 수 있는 타구를 일부러 떨어뜨리는 행위예요.
심판이 고의로 판단하면 타자는 곧바로 아웃되고 주자는 원래 베이스로 돌아가요.', 'rule', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('포수보크', ARRAY['캐처보크','포수 보크','캐처 보크']::text[], '고의4구 때 포수가 투구를 받기 전에 포수석을 벗어나면 선언되는 반칙이에요.
주자가 있으면 보크로 처리해 주자가 진루하고, 주자가 없으면 그 투구를 볼로 선언해요.', 'rule', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('쓰리피트', ARRAY['3피트','쓰리피트 라인','쓰리 피트','3피트 라인']::text[], '1루로 뛰는 주자가 정해진 주로를 벗어나 수비를 방해하면 아웃되는 규정이에요.
2025년부터 3피트 라인 안쪽뿐 아니라 1루 페어지역 안쪽 흙까지 달릴 수 있게 넓어졌어요.', 'rule', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('4사구', ARRAY['사사구','4사구가','볼넷과 몸에 맞는 공']::text[], '볼넷(4구)과 몸에 맞는 공(사구)을 합쳐 부르는 말이에요.
둘 다 타자가 그냥 1루로 나가는 출루예요.
투수 기록에서 함께 묶어 쓰기도 해요.', 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('아웃카운트', ARRAY['아웃 카운트','아웃카운트가']::text[], '그 이닝에 지금까지 잡은 아웃 개수예요.
0개면 무사, 1개면 1사, 2개면 2사라고 불러요.
3개가 되면 공격과 수비가 바뀌어요.', 'basic', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('투구수', ARRAY['투구 수','구수','피치카운트','투구수가']::text[], '투수가 그 경기에서 던진 공의 총 개수예요.
선발은 보통 100개 안팎에서 교체를 고려해요.
적은 투구수로 길게 던지면 효율이 좋다고 해요.', 'pitching', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('인플레이', ARRAY['인 플레이','in play','볼 인 플레이']::text[], '경기가 진행 중이라 주자와 야수가 계속 움직일 수 있는 상태예요.
타구가 페어 지역에 들어가면 인플레이예요.
반대로 멈추는 상태는 볼데드예요.', 'rule', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('출루', ARRAY['출루가','on base']::text[], '타자가 아웃되지 않고 베이스에 나가는 걸 말해요.
안타뿐 아니라 볼넷·몸에 맞는 공도 출루예요.
비율로 보면 출루율이 돼요.', 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('1/3이닝', ARRAY['3분의 1 이닝','이닝 소수점','0.1이닝','이닝 표기']::text[], '이닝은 아웃 3개가 1이닝이라, 아웃 1개가 1/3이닝이에요.
기록지에는 5⅔ 또는 5.2처럼 적어요.
5.2는 5와 3분의 2이닝이라는 뜻이에요.', 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('야구공', ARRAY['공인구','실밥 개수','야구공 실밥']::text[], '가죽 두 조각을 붉은 실로 꿰매 만든 공이에요.
실밥은 108땀으로 꿰매요.
무게는 약 142~149g, 둘레는 약 22.9~23.5cm예요.', 'rule', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('라인업', ARRAY['선발 라인업','오더','라인업이']::text[], '그 경기에 나올 선수와 타순·수비 위치를 적은 명단이에요.
경기 전에 심판에게 제출해요.
DH는 지명타자 자리를 뜻해요.', 'rule', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('베이스', ARRAY['루','1루','일루','2루','이루','3루','삼루','누상']::text[], '주자가 밟고 지나가는 네 지점이에요.
타자는 1루→2루→3루를 거쳐 홈에 들어오면 1점이에요.
한 변 38.1cm 정사각형이고, 홈만 오각형이에요.', 'basic', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('승패세홀', ARRAY['승 패 세 홀','승패세홀 조건','승패세홀이']::text[], '투수 기록인 승리·패전·세이브·홀드를 묶어 부르는 말이에요.
앞선 상황을 지켜 끝내면 세이브, 중간에 지키고 넘기면 홀드예요.
각각 인정 조건이 따로 있어요.', 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('4-6-3 병살', ARRAY['463 병살','4-6-3','463','463병살']::text[], '공이 지나간 수비 위치를 번호로 적은 거예요.
4는 2루수, 6은 유격수, 3은 1루수라서 ''2루수→유격수→1루수'' 병살이라는 뜻이에요.', 'defense', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('5-4-3 병살', ARRAY['543 병살','5-4-3','543','543플레이']::text[], '공이 지나간 수비 위치를 번호로 적은 거예요.
5는 3루수, 4는 2루수, 3은 1루수라서 ''3루수→2루수→1루수'' 병살이라는 뜻이에요.', 'defense', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('파울플라이', ARRAY['파울 플라이','파울뜬공','파울 뜬공']::text[], '파울 지역으로 높이 뜬 타구예요.
야수가 땅에 닿기 전에 잡으면 파울이어도 아웃이에요.
포수 근처로 뜨면 캐처플라이라고 불러요.', 'rule', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('희생타', ARRAY['희생 타','희생타가']::text[], '자기는 아웃되면서 주자를 다음 베이스로 보내거나 불러들이는 타격을 통틀어 부르는 말이에요.
번트로 보내면 희생번트(SH), 뜬공으로 불러들이면 희생플라이(SF)로 따로 기록해요.
둘 다 타수에는 빠져요.', 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('스플리터', ARRAY['스플릿','splitter','스플리터가']::text[], '검지와 중지를 벌려 잡고 던져 홈플레이트 앞에서 살짝 가라앉는 공이에요.
직구와 비슷한 속도로 오다 떨어져 헛스윙을 유도해요.
더 깊게 끼워 낙차를 키운 공은 포크볼이에요.', 'pitching', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('병살', ARRAY['더블플레이','더블 플레이','dp','겟투','병살플레이']::text[], '수비팀이 한 번의 플레이로 아웃 2개를 잡아낸 걸 말해요.
수비 기록이라 영어로는 DP라고 해요.
타자의 땅볼이 원인이면 타자에게 병살타(GIDP)도 함께 기록돼요.', 'defense', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05')
ON CONFLICT (term) DO UPDATE SET
  -- ⚠️ answer 는 여기 없다. 사람이 검수한 문안을 이 경로로 덮지 않는다.
  aliases = excluded.aliases,
  category = excluded.category,
  source_kind = excluded.source_kind,
  source_url = excluded.source_url,
  rule_version = excluded.rule_version
  -- 이 확충이 만든 행만 자기 자신을 재적용한다(멱등). 기존 행은 손대지 않는다.
  WHERE baseball_terms.reviewed_at = DATE '2026-08-05';

-- ② 기존 용어 alias 보강 (합집합이라 기존 alias 는 하나도 잃지 않는다)
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['볼펜','불팬','볼펜투수','불펜투수','구원투수','rp','릴리프','중간계투']::text[]))
  WHERE term = '불펜';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['퍼팩트게임','퍼팩트 게임','퍼펙트 게임','완전경기']::text[]))
  WHERE term = '퍼펙트게임';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['삼진아웃','삼진 아웃','삼짖','스트라이크아웃','k','탈삼진이','삼진이']::text[]))
  WHERE term = '삼진';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['보쿠','보크볼','보크가','피처보크','투수 보크']::text[]))
  WHERE term = '보크';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['병상타','병산','병살타가']::text[]))
  WHERE term = '병살타';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['볼넥','베이스 온 볼스','포 볼']::text[]))
  WHERE term = '볼넷';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['ss','쇼트','숏스탑','유격수가']::text[]))
  WHERE term = '유격수';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['dh','디에이치','지타']::text[]))
  WHERE term = '지명타자';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['ph','핀치히터','대타가']::text[]))
  WHERE term = '대타';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['pr','핀치러너','대주자가']::text[]))
  WHERE term = '대주자';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['c','캐처','안방마님','포수가']::text[]))
  WHERE term = '포수';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['클로저','cp','마무리','소방수']::text[]))
  WHERE term = '마무리투수';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['sp','선발','스타터']::text[]))
  WHERE term = '선발투수';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['등말소','말소','2군 강등']::text[]))
  WHERE term = '등록말소';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['자동고의사구','고의사구','고의4구','고의 사구','자동 고의사구','ibb','고의 자동 사구','자동고의사구가']::text[]))
  WHERE term = '자동고의4구';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['피치클록','피치 클락','피치 클록']::text[]))
  WHERE term = '피치클락';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['서스펜디드 게임','서드펜디드 게임','일시정지 경기']::text[]))
  WHERE term = '서스펜디드게임';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['벤치클라이밍','벤치 클리어링','몸싸움']::text[]))
  WHERE term = '벤치클리어링';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['qs','퀄스','퀄리티 스타트']::text[]))
  WHERE term = '퀄리티스타트';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['싹쓸이','스윕이','시리즈 싹쓸이']::text[]))
  WHERE term = '스윕';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['위닝','위닝 시리즈','위닝이']::text[]))
  WHERE term = '위닝시리즈';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['사구','hbp','데드볼','hpb','hp','사구가']::text[]))
  WHERE term = '몸에 맞는 공';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['ops','출루율 장타율 합']::text[]))
  WHERE term = 'OPS';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['wrc+','wrc plus','가중 득점 창출력']::text[]))
  WHERE term = 'wRC+';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['war','대체선수 대비 승리기여도']::text[]))
  WHERE term = 'WAR';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['whip','이닝당 출루허용률']::text[]))
  WHERE term = 'WHIP';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['era','방어율','이알에이']::text[]))
  WHERE term = '평균자책점';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['낫 아웃','not out','스트라이크아웃 낫아웃','낫아웃아','포수 낫아웃','스트라이크 낫 아웃']::text[]))
  WHERE term = '낫아웃';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['인필드 플라이','인필드플라이가','내야 뜬공 규칙','인플라잉','인필드 플레이']::text[]))
  WHERE term = '인필드플라이';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['드래프트','신인 드래프트','지명']::text[]))
  WHERE term = '신인드래프트';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['fc','필더스초이스','야선']::text[]))
  WHERE term = '야수선택';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['희비','sf','희생 플라이','히븨','희비가','희플']::text[]))
  WHERE term = '희생플라이';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['sh','희생 번트','보내기 번트']::text[]))
  WHERE term = '희생번트';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['sb','스틸','도루가']::text[]))
  WHERE term = '도루';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['rbi','타점이']::text[]))
  WHERE term = '타점';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['hr','홈런이','대포','아치']::text[]))
  WHERE term = '홈런';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['안타가','베이스히트']::text[]))
  WHERE term = '안타';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['2b','이루타','더블']::text[]))
  WHERE term = '2루타';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['3b','삼루타','트리플']::text[]))
  WHERE term = '3루타';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['avg','타율이','타격 평균']::text[]))
  WHERE term = '타율';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['obp','출루율이']::text[]))
  WHERE term = '출루율';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['slg','장타율이']::text[]))
  WHERE term = '장타율';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['r','런','득점이']::text[]))
  WHERE term = '득점';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['1이닝']::text[]))
  WHERE term = '이닝';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['e','에러','실책이']::text[]))
  WHERE term = '실책';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['존이','스트라이크 존','s존']::text[]))
  WHERE term = '스트라이크존';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['패배투수','패전','패투']::text[]))
  WHERE term = '패전투수';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['승투','승리 투수']::text[]))
  WHERE term = '승리투수';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['포크','포크 볼']::text[]))
  WHERE term = '포크볼';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['완투승','완투가','cg']::text[]))
  WHERE term = '완투';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['hld','홀드가','hold']::text[]))
  WHERE term = '홀드';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['sv','세이브가','save']::text[]))
  WHERE term = '세이브';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['연봉 상한','샐러리 캡','샐캡']::text[]))
  WHERE term = '샐러리캡';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['태그 업','리터치','tag up']::text[]))
  WHERE term = '태그업';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['플라이','뜬고','플라이볼','뜬공아웃']::text[]))
  WHERE term = '뜬공';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['그라운드볼','땅볼아웃','내야 땅볼']::text[]))
  WHERE term = '땅볼';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['내야 안타','인필드히트']::text[]))
  WHERE term = '내야안타';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['er','자책','자책점이']::text[]))
  WHERE term = '자책점';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['스리피트']::text[]))
  WHERE term = '쓰리피트';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['643병살']::text[]))
  WHERE term = '6-4-3 병살';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['젖시타','적시타가','타점 적시타']::text[]))
  WHERE term = '적시타';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['포지션','포지션 넘버','수비 위치','수비위치','야구 포지션']::text[]))
  WHERE term = '포지션 번호';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['바빕타','인플레이타율']::text[]))
  WHERE term = 'BABIP';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['게임차의','경기 게임차','순위 게임차']::text[]))
  WHERE term = '게임차';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['보살이가','어시']::text[]))
  WHERE term = '보살';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['가중출루','가중 출루','wra']::text[]))
  WHERE term = 'wOBA';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['완봉승','shutout','완봉이']::text[]))
  WHERE term = '완봉';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['마운드가','투수판','피처스 마운드']::text[]))
  WHERE term = '마운드';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['덕아웃','벤치','더그아웃이']::text[]))
  WHERE term = '더그아웃';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['라인업 순서','배팅오더','타순이']::text[]))
  WHERE term = '타순';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['1군 엔트리','엔트리가','등록 엔트리']::text[]))
  WHERE term = '엔트리';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['라인드라이브','라인 드라이브','라인드라이브드','직선타가']::text[]))
  WHERE term = '직선타';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['승률이','winning percentage','승률 계산']::text[]))
  WHERE term = '승률';

-- ②-b 기존 answer 교정 (명백한 오답만, 목록에 명시된 term 한정)
--
-- 확충은 기존 answer 를 덮지 않는 것이 원칙이다(위 ①의 ON CONFLICT 가 answer 를 뺀다).
-- 다만 기존 답이 명백히 틀렸으면 그대로 둘 수 없다. 조용히 덮지 않고 여기 근거와 함께
-- 개별 UPDATE 로 남긴다. 게이트가 이 목록 밖 시드 answer 변경을 RED 로 잡는다.
-- 병살타: 기존 답변이 병살(DP, 수비 기록) 설명이었다. 병살타(GIDP)는 타자가 친 땅볼로 자기와 주자가 함께 아웃될 때만 붙는 타격 기록이라 정의가 다르다. (삼순 2026-08-05 4차 NO-GO)
UPDATE public.baseball_terms SET answer = '타자가 친 땅볼 때문에 자기와 주자가 함께 아웃된 걸 말해요.
타자에게 붙는 타격 기록이라 영어로는 GIDP라고 해요.
직선타로 주자가 못 돌아와 두 명이 죽으면 병살이지만 병살타는 아니에요.'
  WHERE term = '병살타';

-- 안전장치 A: alias 보강/제거 대상 term 이 하나라도 없으면 통째로 롤백한다.
-- (오타난 term 을 조용히 무시하면 사전은 그대로인데 migration 은 성공으로 보인다)
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO missing FROM unnest(ARRAY['불펜','퍼펙트게임','삼진','보크','병살타','볼넷','유격수','지명타자','대타','대주자','포수','마무리투수','선발투수','등록말소','자동고의4구','피치클락','서스펜디드게임','벤치클리어링','퀄리티스타트','스윕','위닝시리즈','몸에 맞는 공','OPS','wRC+','WAR','WHIP','평균자책점','낫아웃','인필드플라이','신인드래프트','야수선택','희생플라이','희생번트','도루','타점','홈런','안타','2루타','3루타','타율','출루율','장타율','득점','이닝','실책','스트라이크존','패전투수','승리투수','포크볼','완투','홀드','세이브','샐러리캡','태그업','뜬공','땅볼','내야안타','자책점','쓰리피트','6-4-3 병살','적시타','포지션 번호','BABIP','게임차','보살','wOBA','완봉','마운드','더그아웃','타순','엔트리','직선타','승률','위닝시리즈','타순','희생플라이','자책점','몸에 맞는 공','샐러리캡','포크볼','병살타','병살타']::text[]) AS t
  WHERE NOT EXISTS (SELECT 1 FROM public.baseball_terms bt WHERE bt.term = t);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'alias 보강/제거 대상 term 이 사전에 없습니다: %', missing;
  END IF;
END $$;

-- 안전장치 B: 신규 용어가 전부 실제로 들어왔는지 확인한다.
-- ①의 UPDATE 가 reviewed_at 로 제한돼 있으므로, 같은 term 이 다른 날짜로 이미
-- 존재하면 INSERT 도 UPDATE 도 아무 일을 하지 않고 조용히 지나간다. 그 상태를 잡는다.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO missing FROM unnest(ARRAY['적시타','타수','타석','볼카운트','헛스윙','1루타','인사이드더파크홈런','쓰리번트','페어','BABIP','wOBA','ISO','K/9','BB/9','K/BB','FIP','ERA+','OPS+','QS+','실점','피안타','피홈런','게임차','보살','포지션 번호','6-4-3 병살','투수','1루수','2루수','3루수','좌익수','중견수','우익수','내야수','외야수','야수','홈스틸','잔루','만루','무사','1사','유령주자','고의낙구','포수보크','쓰리피트','4사구','아웃카운트','투구수','인플레이','출루','1/3이닝','야구공','라인업','베이스','승패세홀','4-6-3 병살','5-4-3 병살','파울플라이','희생타','스플리터','병살']::text[]) AS t
  WHERE NOT EXISTS (SELECT 1 FROM public.baseball_terms bt WHERE bt.term = t AND bt.reviewed_at = DATE '2026-08-05');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '신규 용어가 적재되지 않았습니다(기존 행과 term 충돌 가능): %', missing;
  END IF;
END $$;

COMMIT;
