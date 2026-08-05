-- ============================================================
-- 야잘알봇 검수 사전 확충 1차 (2026-08-05)
--
-- 근거: 운영 미답변 로그 1,075건 중 TERM 라벨 479건을 실측한 결과,
--       현재 사전 132종 + 기존 정규화로는 476건이 미매칭이었다.
--       (3건만 정규화로 잡혔고 나머지는 사전에 아예 없거나 표기가 달랐다)
--
-- 이 migration 이 하는 일:
--   ① 신규 용어 153종 삽입
--   ② 기존 용어에 alias 82건 보강 (오타·약어·구어 표기)
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
  ('야구', ARRAY['baseball','야구가뭐야']::text[], '9명씩 두 팀이 공격과 수비를 번갈아 하는 구기 종목이에요.
타자가 공을 치고 1·2·3루를 돌아 홈에 들어오면 1점이에요.
KBO 정규 경기는 9이닝으로 치러요.', 'basic', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('적시타', ARRAY['타점타','타점 안타','rbi 안타','적시안타']::text[], '주자가 있을 때 안타를 쳐서 그 주자를 홈으로 불러들인 안타예요.
타점(RBI)이 기록돼요.
2점을 불러들이면 2타점 적시타라고 불러요.', 'batting', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('타수', ARRAY['ab','at bat','타수가']::text[], '타율을 계산할 때 분모가 되는 숫자예요.
타석 중에서 볼넷·몸에 맞는 공·희생번트·희생플라이는 타수에서 빠져요.
타율 = 안타 ÷ 타수예요.', 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('타석', ARRAY['pa','plate appearance','타석수']::text[], '타자가 타자석에 들어서서 한 번의 결과가 나올 때까지를 말해요.
볼넷·사구·희생타도 모두 타석에 포함돼요.
타수보다 넓은 개념이에요.', 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('초구', ARRAY['첫 구','first pitch','초구딱']::text[], '한 타석에서 투수가 던지는 첫 번째 공이에요.
초구를 노려 바로 치는 걸 팬들은 ''초구딱''이라고 불러요.
초구 스트라이크는 투수에게 큰 이득이에요.', 'basic', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('볼카운트', ARRAY['카운트','count','볼 카운트']::text[], '지금 타석의 볼과 스트라이크 개수예요.
보통 ''볼-스트라이크'' 순서로 2-1처럼 읽어요.
볼 4개면 볼넷, 스트라이크 3개면 삼진이에요.', 'basic', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('헛스윙', ARRAY['헛 스윙','swing and miss','헛스윙이']::text[], '타자가 방망이를 휘둘렀는데 공을 맞히지 못한 거예요.
존을 벗어난 공이어도 헛스윙하면 스트라이크예요.
3개째면 헛스윙 삼진이에요.', 'basic', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('루킹삼진', ARRAY['루킹 삼진','스탠딩삼진','서서 삼진','루킹삼진아웃','루킹 삼진 아웃']::text[], '타자가 방망이를 휘두르지 않고 서서 삼진을 당한 거예요.
마지막 공이 스트라이크로 판정되면서 아웃돼요.
반대로 휘둘러서 당하면 헛스윙 삼진이에요.', 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('삼구삼진', ARRAY['3구삼진','삼구 삼진']::text[], '공 3개 만에 삼진으로 물러난 거예요.
타자 입장에선 가장 아쉬운 결과 중 하나예요.
투수는 공 3개로 아웃을 잡아 효율이 아주 좋아요.', 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('1루타', ARRAY['일루타','single','단타']::text[], '타자가 안타를 치고 1루까지만 나간 거예요.
가장 기본이 되는 안타예요.
기록지에는 안타(H)로 함께 집계돼요.', 'batting', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('밀어치기', ARRAY['밀어 치기','반대 방향 타격','밀어친다','밀어치는']::text[], '타자가 몸쪽이 아닌 바깥쪽 공을 자기 반대편 방향으로 치는 거예요.
오른손 타자는 우측, 왼손 타자는 좌측으로 가요.
수비 시프트를 깨는 데 유용해요.', 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('당겨치기', ARRAY['당기는 타구','당겨 치기','풀히팅']::text[], '타자가 자기 앞쪽 방향으로 강하게 끌어당겨 치는 거예요.
오른손 타자는 좌측, 왼손 타자는 우측으로 타구가 가요.
장타가 나기 쉬운 대신 시프트에 걸리기도 해요.', 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('어퍼스윙', ARRAY['어퍼 스윙','upper swing','어퍼컷 스윙']::text[], '방망이가 아래에서 위로 올라가며 지나가는 스윙이에요.
타구에 각도가 생겨 뜬공·홈런이 나오기 쉬워요.
반대로 지면과 평행하게 지나가면 레벨스윙이에요.', 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('레벨스윙', ARRAY['레벨 스윙','level swing','래벨스윙']::text[], '방망이가 지면과 거의 평행하게 지나가는 스윙이에요.
공을 맞히는 확률이 높아 정확도에 유리해요.
올려 치면 어퍼스윙, 찍어 내리면 다운스윙이에요.', 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('타자일순', ARRAY['타자 일순','타순 한 바퀴','타자일순이']::text[], '한 이닝에 1번부터 9번까지 타자가 모두 타석에 들어선 거예요.
그 이닝에 최소 9명이 나왔다는 뜻이라 대량 득점이 나기 쉬워요.
타순이 다시 돌아왔다고도 해요.', 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('장외홈런', ARRAY['장외 홈런','담장 밖 홈런']::text[], '타구가 구장 관중석까지 넘어가 경기장 밖으로 나간 홈런이에요.
기록상으로는 일반 홈런과 똑같이 1개예요.
비거리가 아주 길 때 나와요.', 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('인사이드더파크홈런', ARRAY['인사이드 더 파크 홈런','러닝홈런','그라운드홈런','장내홈런']::text[], '타구가 담장을 넘지 않았는데 타자가 **수비 실책 없이** 홈까지 달려 들어온 홈런이에요.
실책 덕에 홈에 들어오면 홈런이 아니라 안타와 실책으로 기록돼요.
러닝홈런이라고도 불러요.', 'batting', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('백투백', ARRAY['백투백 홈런','back to back','연속타자 홈런']::text[], '앞뒤 타자가 연달아 홈런을 친 걸 말해요.
세 명 연속이면 백투백투백이라고 불러요.
분위기를 한 번에 가져오는 장면이에요.', 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('투런', ARRAY['투런포','2런홈런','투런 홈런','2점 홈런']::text[], '주자 1명이 있을 때 나온 홈런이라 한 번에 2점이 들어가는 거예요.
''포''는 대포(홈런)를 뜻하는 표현이에요.
주자 2명이면 쓰리런이에요.', 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('쓰리런', ARRAY['쓰리런포','3런홈런','쓰리런 홈런','3점 홈런','스리런']::text[], '주자 2명이 있을 때 나온 홈런이라 한 번에 3점이 들어가요.
주자가 꽉 찬 상태면 만루홈런(4점)이에요.
경기 흐름을 크게 바꾸는 한 방이에요.', 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('좌전안타', ARRAY['좌전 안타','좌익수 앞 안타']::text[], '좌익수 앞에 떨어진 안타예요.
중견수 앞이면 중전안타, 우익수 앞이면 우전안타라고 불러요.
타구가 간 방향으로 이름을 붙이는 표현이에요.', 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('중전안타', ARRAY['중전 안타','중견수 앞 안타']::text[], '중견수 앞에 떨어진 안타예요.
좌익수 앞이면 좌전안타, 우익수 앞이면 우전안타예요.
방향을 앞글자로 줄여 부르는 중계 표현이에요.', 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('우전안타', ARRAY['우전 안타','우익수 앞 안타']::text[], '우익수 앞에 떨어진 안타예요.
좌익수 앞이면 좌전안타, 중견수 앞이면 중전안타예요.
타구 방향을 줄여 부르는 표현이에요.', 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('좌중간안타', ARRAY['좌중간 안타','좌중간을 가르는 안타']::text[], '좌익수와 중견수 사이를 가르고 나간 안타예요.
수비 사이로 빠져 2루타가 되는 경우가 많아요.
우익수와 중견수 사이면 우중간안타예요.', 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('우중간안타', ARRAY['우중간 안타','우중간을 가르는 안타']::text[], '우익수와 중견수 사이를 가르고 나간 안타예요.
수비 사이라 타구가 멀리 굴러 장타가 되기 쉬워요.
좌익수 쪽이면 좌중간안타예요.', 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('기습번트', ARRAY['기습 번트','드래그번트','푸시번트','세이프티번트']::text[], '수비가 예상하지 못한 상황에서 자기가 살아 나가려고 대는 번트예요.
희생번트와 달리 타자 본인의 출루가 목적이에요.
발 빠른 타자가 주로 시도해요.', 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('쓰리번트', ARRAY['스리번트','3번트','투스트라이크 번트']::text[], '2스트라이크에서 시도하는 번트예요.
이때 번트한 공이 파울이 되면 곧바로 삼진 아웃이에요.
그래서 위험 부담이 큰 작전이에요.', 'rule', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('강공', ARRAY['강공 전환','강공전환','강공책']::text[], '번트 같은 작전 대신 타자가 그대로 크게 치도록 두는 거예요.
번트 자세를 잡았다가 바꾸면 ''강공 전환''이라고 해요.
한 방으로 큰 점수를 노릴 때 써요.', 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('버스터', ARRAY['버스트']::text[], '번트 자세를 취해 수비를 앞으로 끌어낸 뒤 곧바로 스윙으로 바꿔 치는 작전이에요.
수비가 전진해 있어 빈 곳이 생겨요.
한국에서 흔히 ''버스터''라고 불러요.', 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('페어', ARRAY['페어볼','페어 볼','페어지역','페어 지역']::text[], '타구가 1루선과 3루선 안쪽(페어 지역)에 들어온 걸 말해요.
페어면 경기가 계속되고 타자는 뛰어야 해요.
선 바깥으로 나가면 파울이에요.', 'rule', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('빠던', ARRAY['배트플립','빠따던지기','bat flip']::text[], '홈런을 확신했을 때 방망이를 시원하게 던지는 세리머니예요.
''빠따 던지기''를 줄인 말이에요.
KBO 특유의 문화로 해외에서도 유명해요.', 'culture', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('제구', ARRAY['제구력','컨트롤']::text[], '투수가 원하는 곳에 공을 정확히 던지는 능력이에요.
제구가 흔들리면 볼넷이 늘어나요.
구속·구위와 함께 투수를 평가하는 핵심 요소예요.', 'pitching', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('구위', ARRAY['공의 힘','구위가']::text[], '투수가 던진 공이 타자에게 얼마나 위력적으로 느껴지는지를 뜻해요.
구속뿐 아니라 회전·움직임까지 합친 표현이에요.
구위가 좋으면 맞아도 잘 뻗지 않아요.', 'pitching', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('변화구', ARRAY['브레이킹볼','변화구가']::text[], '직구와 달리 휘거나 떨어지도록 던지는 공이에요.
슬라이더·커브·체인지업·포크볼 등이 여기에 들어가요.
타자의 타이밍을 뺏는 게 목적이에요.', 'pitching', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('투나씽', ARRAY['투낫싱','2-0','투 나씽','2볼 0스트라이크']::text[], '볼 2개, 스트라이크 0개인 볼카운트를 부르는 말이에요.
타자에게 유리해서 좋은 공을 노리기 좋아요.
영어 ''two nothing''에서 온 표현이에요.', 'basic', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('볼배합', ARRAY['볼 배합']::text[], '포수가 어떤 공을 어떤 순서로 던질지 짜는 것을 말해요.
타자 성향과 볼카운트에 따라 달라져요.
포수의 리드라고도 불러요.', 'pitching', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
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
  ('할푼리', ARRAY['할 푼 리','몇할몇푼몇리','타율 읽는 법','할푼리가']::text[], '타율 소수점을 읽는 방식이에요.
첫째 자리가 할, 둘째가 푼, 셋째가 리예요.
.325면 3할 2푼 5리라고 읽어요.', 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('실점', ARRAY['실점이','runs allowed']::text[], '투수가 마운드에 있는 동안 상대에게 준 점수 전부예요.
이 중 실책 같은 수비 실수 때문에 난 점수를 빼면 자책점이에요.
평균자책점은 자책점으로 계산해요.', 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('피안타', ARRAY['피 안타','맞은 안타']::text[], '투수가 상대 타자에게 맞은 안타예요.
투수 기록에서는 ''피''를 붙여 피안타·피홈런처럼 불러요.
적을수록 좋은 기록이에요.', 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('피홈런', ARRAY['피 홈런','맞은 홈런','탈홈런']::text[], '투수가 상대에게 맞은 홈런이에요.
한 번에 여러 점을 주기 때문에 투수에게 가장 아픈 기록이에요.
일부 팬은 농담처럼 ''탈홈런''이라고 부르기도 해요.', 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('게임차', ARRAY['게임 차','승차','게임차가','경기차']::text[], '순위표에서 두 팀의 승패 차이를 나타내는 값이에요.
(위 팀 승 - 아래 팀 승)과 (아래 팀 패 - 위 팀 패)를 더해 2로 나눠요.
0.5면 반 경기 차예요.', 'league', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('10-10 클럽', ARRAY['10-10','1010클럽','10홈런 10도루']::text[], '한 시즌에 홈런 10개와 도루 10개를 동시에 달성한 기록이에요.
장타력과 주력을 함께 갖췄다는 뜻이에요.
20-20, 30-30, 40-40으로 올라갈수록 희귀해요.', 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('30-30 클럽', ARRAY['30-30','3030클럽']::text[], '한 시즌 홈런 30개와 도루 30개를 동시에 기록한 걸 말해요.
20-20, 40-40도 같은 방식으로 불러요.
숫자가 커질수록 KBO에서도 손에 꼽는 기록이에요.', 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
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
  ('주루', ARRAY['베이스러닝','주루플레이','주루가']::text[], '주자가 베이스를 도는 모든 움직임을 말해요.
한 베이스를 더 갈지 판단하는 센스가 중요해요.
잘못 판단해 아웃되면 주루사예요.', 'running', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('주루사', ARRAY['주루 사','주루사가','주루 아웃']::text[], '주자가 베이스를 돌다가 아웃된 걸 말해요.
무리하게 한 베이스를 더 가려다 태그되는 경우가 많아요.
타자의 안타가 헛수고가 돼 아쉬운 장면이에요.', 'running', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
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
  ('잔루만루', ARRAY['잔루 만루','잔루만루가']::text[], '만루 찬스를 만들고도 점수를 못 내고 주자를 그대로 남긴 상황을 팬들이 부르는 말이에요.
정식 기록 용어는 아니고, 답답함을 표현하는 표현이에요.', 'culture', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('유령주자', ARRAY['유령 주자','승부치기 주자','고스트러너']::text[], '승부치기에서 이닝 시작 때 안타 없이 미리 베이스에 놓아두는 주자예요.
KBO 정규시즌에는 쓰지 않고, 승부치기를 적용하는 대회에서 사용해요.', 'rule', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('슬라이딩', ARRAY['헤드퍼스트 슬라이딩','헤드 퍼스트 슬라이딩','헤드퍼스트슬라이딩','슬라이딩이']::text[], '주자가 베이스에 몸을 미끄러뜨리며 들어가는 동작이에요.
발부터 들어가는 방식과 머리부터 들어가는 헤드퍼스트가 있어요.
헤드퍼스트는 빠른 대신 부상 위험이 커요.', 'running', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('고의낙구', ARRAY['고의 낙구','고의낙구가','일부러 떨어뜨리기']::text[], '야수가 병살을 노리고 잡을 수 있는 타구를 일부러 떨어뜨리는 행위예요.
심판이 고의로 판단하면 타자는 곧바로 아웃되고 주자는 원래 베이스로 돌아가요.', 'rule', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('포수보크', ARRAY['캐처보크','포수 보크','캐처 보크']::text[], '고의4구를 줄 때 포수가 공을 받기 전에 포수석을 벗어나면 선언되는 반칙이에요.
선언되면 투구는 볼이 되고 주자는 한 베이스씩 나가요.', 'rule', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('쓰리피트', ARRAY['3피트','쓰리피트 라인','쓰리 피트','3피트 라인']::text[], '1루로 뛰는 주자가 정해진 주로를 벗어나 수비를 방해하면 아웃되는 규정이에요.
2025년부터 3피트 라인 안쪽뿐 아니라 1루 페어지역 안쪽 흙까지 달릴 수 있게 넓어졌어요.', 'rule', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('4사구', ARRAY['사사구','4사구가','볼넷과 몸에 맞는 공']::text[], '볼넷(4구)과 몸에 맞는 공(사구)을 합쳐 부르는 말이에요.
둘 다 타자가 그냥 1루로 나가는 출루예요.
투수 기록에서 함께 묶어 쓰기도 해요.', 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('스트레이트 볼넷', ARRAY['스트레이트볼넷','스트레이트 4구','연속 4볼']::text[], '공 4개를 연달아 볼로 던져 내준 볼넷이에요.
스트라이크를 하나도 못 넣었다는 뜻이라 제구 난조 신호예요.
기록상으로는 일반 볼넷과 같아요.', 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('아웃카운트', ARRAY['아웃 카운트','아웃카운트가']::text[], '그 이닝에 지금까지 잡은 아웃 개수예요.
0개면 무사, 1개면 1사, 2개면 2사라고 불러요.
3개가 되면 공격과 수비가 바뀌어요.', 'basic', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('1선발', ARRAY['원선발','1선발이','에이스','1선발 뜻']::text[], '선발 로테이션에서 가장 먼저·가장 믿고 내보내는 투수예요.
팀의 에이스를 뜻해요.
순서대로 2선발, 3선발이라고 불러요.', 'pitching', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('선발 로테이션', ARRAY['로테이션','선발로테이션','5인 로테이션']::text[], '선발투수들이 정해진 순서로 돌아가며 등판하는 운영 방식이에요.
KBO는 보통 5명이 한 바퀴를 도는 5인 로테이션을 써요.
등판 사이에 나흘 정도 쉬어요.', 'pitching', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('필승조', ARRAY['필승 조','필승조가','셋업맨']::text[], '이기고 있는 접전에서 리드를 지키려고 내보내는 핵심 불펜 투수들이에요.
보통 7~8회를 맡고 뒤를 마무리투수가 이어요.
반대 상황엔 추격조가 나와요.', 'pitching', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('추격조', ARRAY['추격 조','추격조가','패전조']::text[], '점수가 벌어져 지고 있을 때 나오는 불펜 투수들이에요.
따라붙을 때까지 실점을 막아 주는 역할이에요.
크게 지고 있을 때 나오면 패전조라고도 불러요.', 'pitching', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('터프세이브', ARRAY['터프 세이브','tough save']::text[], '동점 주자가 이미 나가 있는 어려운 상황에서 지켜 낸 세이브예요.
일반 세이브보다 훨씬 부담이 큰 상황이에요.
기록상으로는 세이브 1개로 같아요.', 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('투구수', ARRAY['투구 수','구수','피치카운트','투구수가']::text[], '투수가 그 경기에서 던진 공의 총 개수예요.
선발은 보통 100개 안팎에서 교체를 고려해요.
적은 투구수로 길게 던지면 효율이 좋다고 해요.', 'pitching', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('피치컴', ARRAY['피치콤','pitchcom','사인 전달 장치']::text[], '포수가 버튼을 눌러 투수에게 구종·코스를 소리로 전달하는 전자 장비예요.
손 사인을 훔쳐보는 문제를 막고 경기 시간도 줄여 줘요.', 'rule', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('가을야구', ARRAY['포스트시즌','가을 야구','가을야구가']::text[], '정규시즌이 끝난 뒤 상위 팀들이 치르는 포스트시즌을 부르는 말이에요.
와일드카드결정전부터 준플레이오프·플레이오프·한국시리즈까지예요.', 'league', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('영구결번', ARRAY['영구 결번','영구결번이','번호 영구 결번']::text[], '구단이 특정 선수의 등번호를 기려 다시는 다른 선수에게 주지 않는 것이에요.
팀 역사에 크게 기여한 선수에게만 주는 최고 예우예요.', 'culture', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('프랜차이즈 스타', ARRAY['프랜차이즈스타','프랜차이즈 선수','프랜차이즈','원클럽맨']::text[], '한 구단에서 오래 뛰며 팀을 대표하게 된 선수를 말해요.
이적 없이 한 팀에서만 뛰면 원클럽맨이라고도 불러요.
구단 상징 같은 존재예요.', 'culture', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('옵트아웃', ARRAY['옵트 아웃','opt out','옵트아웃이']::text[], '계약 기간이 남아 있어도 선수가 계약을 끝내고 FA로 나갈 수 있게 미리 넣어 둔 조항이에요.
성적이 좋을 때 더 좋은 조건을 노리려고 사용해요.', 'league', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('승요', ARRAY['승리요정','승요가','승리 요정']::text[], '그 선수가 나오거나 그 팬이 직관하면 팀이 이긴다는 팬들의 애칭이에요.
''승리 요정''을 줄인 말이에요.
기록 용어는 아니고 재미로 쓰는 표현이에요.', 'culture', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('허슬두', ARRAY['허슬 두','허슬두산']::text[], '두산 베어스를 부르는 별명이에요.
몸을 아끼지 않는 허슬 플레이(hustle)와 두산을 합친 말이에요.
끈질긴 야구 스타일을 상징해요.', 'culture', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('엘롯라시코', ARRAY['엘롯 라시코','lg 롯데 더비']::text[], 'LG 트윈스와 롯데 자이언츠의 맞대결을 부르는 팬 애칭이에요.
축구의 엘 클라시코에서 따온 말이에요.
두 팀 모두 팬이 많아 흥행 카드로 꼽혀요.', 'culture', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('잠실시리즈', ARRAY['잠실 시리즈','잠실더비','엘두']::text[], '잠실야구장을 함께 쓰는 LG 트윈스와 두산 베어스의 맞대결이에요.
같은 구장을 홈으로 쓰는 두 팀이라 라이벌 의식이 강해요.', 'culture', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('코시', ARRAY['코리아시리즈','한국시리즈 줄임말']::text[], '한국시리즈를 줄여 부르는 말이에요.
그 해 챔피언을 가리는 마지막 시리즈예요.
7전 4선승제로 치러요.', 'league', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('불문율', ARRAY['불문율이','언리튼 룰','암묵적인 룰']::text[], '규칙집에는 없지만 선수들 사이에서 지켜지는 예의예요.
크게 이기고 있을 때 도루를 자제하는 것 등이 대표적이에요.
어기면 신경전이 벌어지기도 해요.', 'culture', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('호수비', ARRAY['호수비가','호 수비','굿 디펜스','슈퍼캐치']::text[], '잡기 어려운 타구를 멋지게 처리한 뛰어난 수비예요.
안타가 될 뻔한 공을 막아 흐름을 끊어 줘요.
기록 용어는 아니고 감탄의 표현이에요.', 'defense', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('본헤드 플레이', ARRAY['본헤드플레이','본헤드','bonehead play']::text[], '판단 착오로 벌어진 어이없는 실수를 말해요.
아웃카운트를 잘못 세거나 베이스를 밟지 않고 지나가는 경우가 대표적이에요.
기록상 실책과는 별개예요.', 'culture', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('특타', ARRAY['특별타격훈련','특타가','특별 타격 훈련']::text[], '정규 훈련 외에 따로 더 하는 특별 타격 훈련이에요.
타격감이 떨어졌을 때 경기 전후로 진행해요.
''특별 타격''을 줄인 말이에요.', 'culture', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('시즌아웃', ARRAY['시즌 아웃','시즌아웃이']::text[], '부상이나 수술로 남은 시즌을 뛸 수 없게 된 상태를 말해요.
보통 1군 엔트리에서 빠지고 재활에 들어가요.
공식 용어라기보다 언론·팬이 쓰는 표현이에요.', 'culture', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('2차 드래프트', ARRAY['2차드래프트','이차 드래프트','2차 드래프트가']::text[], '각 구단이 보호선수 명단에서 빠진 선수를 다른 팀이 지명해 데려가는 제도예요.
출전 기회가 적은 선수에게 새 기회를 주는 목적이에요.', 'league', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('연고지', ARRAY['연고 지역','연고지가']::text[], '구단이 홈으로 삼는 지역이에요.
홈경기를 치르는 도시이자 팬층의 기반이 돼요.
KBO 10개 구단이 각각 연고지를 두고 있어요.', 'league', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('월드시리즈', ARRAY['월드 시리즈','world series','ws']::text[], '미국 메이저리그(MLB)의 챔피언을 가리는 최종 시리즈예요.
KBO의 한국시리즈에 해당해요.
7전 4선승제로 치러요.', 'league', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('WBC', ARRAY['wbc','월드베이스볼클래식','월드 베이스볼 클래식']::text[], '국가대표팀이 겨루는 국제 야구 대회예요.
월드 베이스볼 클래식의 약자예요.
보통 시즌 시작 전인 3월에 열려요.', 'league', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('상반기', ARRAY['전반기']::text[], '정규시즌에서 올스타 브레이크 **앞** 구간이에요.
전반기라고도 불러요.
올스타전 뒤는 후반기예요.', 'league', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('루징시리즈', ARRAY['루징 시리즈','루징']::text[], '한 팀과의 연속 경기(시리즈)에서 진 경기가 더 많은 걸 말해요.
반대로 더 많이 이기면 위닝시리즈예요.
전부 지면 스윕당했다고 해요.', 'league', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('수훈선수', ARRAY['수훈 선수','수훈갑','수훈선수가']::text[], '그 경기 승리에 가장 크게 기여한 선수예요.
경기 후 인터뷰의 주인공이 돼요.
팬들은 ''오늘의 수훈갑''이라고 부르기도 해요.', 'culture', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('예고선발', ARRAY['예고 선발','선발 예고','예고선발이']::text[], '다음 경기에 나올 선발투수를 미리 공개하는 제도예요.
팬은 관전 계획을, 상대 팀은 라인업을 준비할 수 있어요.
보통 경기 전날 발표해요.', 'league', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('DTD', ARRAY['dtd','내려갈 팀은 내려간다']::text[], '''내려갈 팀은 내려간다''를 줄인 팬들의 표현이에요.
초반에 잘나가도 결국 제자리를 찾아간다는 뜻으로 써요.
놀림 섞인 유행어예요.', 'culture', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('타격감', ARRAY['타격 감','감이 좋다','타격감이']::text[], '타자가 공을 얼마나 잘 맞히고 있는지 최근 상태를 뜻해요.
기록으로 딱 정해진 건 아니고 최근 경기 성적으로 이야기해요.
좋으면 ''감이 올라왔다''고 해요.', 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('거포', ARRAY['거포 뜻','슬러거','장타자']::text[], '홈런과 장타를 많이 치는 힘 좋은 타자예요.
큰 대포라는 뜻에서 나온 말이에요.
순수 장타력을 보는 ISO가 높게 나와요.', 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('교타자', ARRAY['컨택 히터','정확도 타자']::text[], '삼진이 적고 공을 잘 맞혀 안타를 많이 만드는 타자예요.
장타보다 정확도가 강점이에요.
반대로 힘으로 승부하면 거포예요.', 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('좌완', ARRAY['좌투','왼손투수','좌완투수']::text[], '왼손으로 공을 던지는 투수예요.
왼손 타자에게 상대적으로 유리하다고 봐요.
오른손으로 던지면 우완이에요.', 'pitching', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('인플레이', ARRAY['인 플레이','in play','볼 인 플레이']::text[], '경기가 진행 중이라 주자와 야수가 계속 움직일 수 있는 상태예요.
타구가 페어 지역에 들어가면 인플레이예요.
반대로 멈추는 상태는 볼데드예요.', 'rule', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('송구', ARRAY['송구가','throw','던지기']::text[], '수비수가 공을 다른 야수에게 던지는 동작이에요.
빗나가면 송구 실책이 되고 주자가 더 진루해요.
정확도와 어깨 힘이 함께 필요해요.', 'defense', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('수비', ARRAY['수비가','디펜스']::text[], '공격팀의 타구를 처리해 아웃을 잡고 점수를 막는 쪽이에요.
투수·포수·내야수·외야수 9명이 나가요.
아웃 3개를 잡으면 공격으로 바뀌어요.', 'defense', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('출루', ARRAY['출루가','on base']::text[], '타자가 아웃되지 않고 베이스에 나가는 걸 말해요.
안타뿐 아니라 볼넷·몸에 맞는 공도 출루예요.
비율로 보면 출루율이 돼요.', 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('삼자범퇴', ARRAY['삼자 범퇴','삼자번퇴','3자범퇴','1-2-3 이닝']::text[], '한 이닝에서 타자 3명을 출루시키지 않고 그대로 삼자 아웃으로 끝낸 거예요.
투수 입장에선 가장 깔끔한 이닝이에요.
투구수도 아낄 수 있어요.', 'pitching', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
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
  ('무사 만루', ARRAY['무사만루','노아웃 만루']::text[], '아웃 개수와 주자 위치를 한 번에 부르는 표현이에요.
앞이 아웃 수(무사·1사·2사), 뒤가 주자 상황(1루·만루)이에요.
무사 만루는 아웃 없이 주자가 꽉 찬 최고의 찬스예요.', 'basic', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('스윙', ARRAY['스윙이','swing','방망이 휘두르기']::text[], '타자가 공을 치려고 방망이를 휘두르는 동작이에요.
맞히지 못하면 헛스윙으로 스트라이크예요.
휘두르다 멈춘 애매한 동작은 체크스윙으로 판정해요.', 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('세이버매트릭스', ARRAY['세이버메트릭스','sabermetrics','세이버','세이버 지표']::text[], '통계로 야구를 분석하는 방법이에요.
WAR·wRC+·OPS·FIP·BABIP 같은 지표가 여기서 나왔어요.
눈에 안 보이는 기여도를 숫자로 보려는 접근이에요.', 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('승패세홀', ARRAY['승 패 세 홀','승패세홀 조건','승패세홀이']::text[], '투수 기록인 승리·패전·세이브·홀드를 묶어 부르는 말이에요.
앞선 상황을 지켜 끝내면 세이브, 중간에 지키고 넘기면 홀드예요.
각각 인정 조건이 따로 있어요.', 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('등번호', ARRAY['백넘버','등번호가']::text[], '유니폼 등에 붙는 선수 고유 번호예요.
같은 팀 안에서 겹칠 수 없어요.
팀에 큰 족적을 남기면 영구결번으로 남기기도 해요.', 'culture', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('포수 미트', ARRAY['미트','캐처미트','포수미트']::text[], '포수가 빠른 공을 받기 위해 쓰는 두툼한 전용 글러브예요.
손가락이 나뉘어 있지 않아 일반 글러브와 달라요.
1루수도 전용 미트를 써요.', 'rule', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('볼보이', ARRAY['볼걸','볼 보이','볼보이가']::text[], '파울 지역에 앉아 굴러 온 공을 처리하고 심판에게 공을 전달하는 진행 요원이에요.
경기가 끊기지 않게 도와줘요.', 'culture', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('메이저리그', ARRAY['mlb','메이저리거','메이져리거','빅리그','메이져리그']::text[], '미국 프로야구 최상위 리그예요.
줄여서 MLB라고 하고, 거기서 뛰는 선수를 메이저리거라고 불러요.
최종 우승은 월드시리즈로 가려요.', 'league', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('아시아시리즈', ARRAY['아시아 시리즈','asia series']::text[], '한국·일본·대만 등 아시아 프로리그 챔피언들이 겨루던 국제 대회예요.
각국 우승팀이 참가했어요.
최근에는 정기적으로 열리지 않아요.', 'league', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('섀도플레이', ARRAY['섀도 플레이','쉐도우플레이','섀도우 플레이']::text[], '타구가 오지 않아도 야수가 상황에 맞춰 미리 자리를 잡고 움직여 주는 플레이예요.
중계 플레이나 베이스 커버가 대표적이에요.', 'defense', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('캐처플라이', ARRAY['캐처 플라이','포수 뜬공']::text[], '타자가 친 공이 포수 근처로 높이 떠서 잡히는 뜬공이에요.
파울 지역에서 잡혀도 아웃이에요.
포수가 마스크를 벗고 쫓아가는 장면이 자주 나와요.', 'defense', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('스탯', ARRAY['스탯이','stat','기록 지표','스탯쌓기']::text[], '선수의 기록·성적을 뜻하는 말이에요.
타율·홈런·타점 같은 기본 기록부터 WAR·OPS 같은 지표까지 포함해요.
영어 statistics에서 온 말이에요.', 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('도미넌트', ARRAY['dominant','도미넌트가','압도적인 투구']::text[], '상대를 압도할 만큼 압도적으로 잘했다는 뜻이에요.
주로 투수가 상대 타선을 거의 무력화시켰을 때 써요.
기록 용어는 아니고 중계·팬들이 쓰는 표현이에요.', 'culture', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('발야구', ARRAY['발 야구','스몰볼','발야구가']::text[], '홈런보다 발로 승부하는 야구를 뜻해요.
도루·번트·과감한 주루로 점수를 만들어요.
반대로 장타 중심이면 하드히팅 야구라고 불러요.', 'culture', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('삼구', ARRAY['삼구가','공 3개','3구']::text[], '투수가 던진 세 번째 공을 뜻해요.
공 3개로 삼진을 잡으면 삼구삼진이에요.
첫 공은 초구라고 부르죠.', 'basic', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('마스크를 쓴다', ARRAY['마스크','마스크를 쓰다','마스크 쓰다']::text[], '그날 경기에 포수로 출장한다는 뜻이에요.
포수만 보호 마스크를 쓰기 때문에 생긴 표현이에요.
''오늘 마스크는 ‹선수›''처럼 써요.', 'culture', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('4-6-3 병살', ARRAY['463 병살','4-6-3','463','463병살']::text[], '공이 지나간 수비 위치를 번호로 적은 거예요.
4는 2루수, 6은 유격수, 3은 1루수라서 ''2루수→유격수→1루수'' 병살이라는 뜻이에요.', 'defense', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('5-4-3 병살', ARRAY['543 병살','5-4-3','543','543플레이']::text[], '공이 지나간 수비 위치를 번호로 적은 거예요.
5는 3루수, 4는 2루수, 3은 1루수라서 ''3루수→2루수→1루수'' 병살이라는 뜻이에요.', 'defense', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('20-20 클럽', ARRAY['20-20','2020클럽','20홈런 20도루']::text[], '한 시즌에 홈런 20개와 도루 20개를 함께 기록한 걸 말해요.
장타력과 주력을 같이 갖췄다는 뜻이에요.
30-30, 40-40으로 갈수록 희귀해져요.', 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('40-40 클럽', ARRAY['40-40','4040클럽','40홈런 40도루']::text[], '한 시즌에 홈런 40개와 도루 40개를 함께 기록한 걸 말해요.
장타력과 주력을 모두 갖춰야 해서 KBO에서도 손에 꼽는 대기록이에요.
30-30보다 한 단계 위예요.', 'record', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('파울플라이', ARRAY['파울 플라이','파울뜬공','파울 뜬공']::text[], '파울 지역으로 높이 뜬 타구예요.
야수가 땅에 닿기 전에 잡으면 파울이어도 아웃이에요.
포수 근처로 뜨면 캐처플라이라고 불러요.', 'rule', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('무사 1루', ARRAY['무사1루','노아웃 1루']::text[], '아웃이 하나도 없고 1루에만 주자가 있는 상황이에요.
앞이 아웃 수(무사·1사·2사), 뒤가 주자 위치예요.
번트나 히트앤런으로 주자를 보내기 좋은 장면이에요.', 'basic', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('2사 만루', ARRAY['2사만루','투아웃 만루']::text[], '아웃이 2개인데 1·2·3루에 주자가 모두 있는 상황이에요.
안타 하나면 여러 점이 나지만, 아웃 하나면 그대로 이닝이 끝나요.
주자는 전원 자동 스타트예요.', 'basic', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('희생타', ARRAY['희생 타','희생타가']::text[], '자기는 아웃되면서 주자를 다음 베이스로 보내거나 불러들이는 타격을 통틀어 부르는 말이에요.
번트로 보내면 희생번트(SH), 뜬공으로 불러들이면 희생플라이(SF)로 따로 기록해요.
둘 다 타수에는 빠져요.', 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('우완', ARRAY['우투','오른손투수','우완투수']::text[], '오른손으로 공을 던지는 투수예요.
오른손 타자에게 상대적으로 유리하다고 봐요.
왼손으로 던지면 좌완이에요.', 'pitching', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
  ('후반기', ARRAY['후반기가','시즌 후반기']::text[], '정규시즌에서 올스타 브레이크 **뒤** 구간이에요.
순위 싸움이 가장 치열해지는 시기예요.
올스타전 앞은 전반기(상반기)예요.', 'league', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),
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
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['ip','1회','1이닝','9회']::text[]))
  WHERE term = '이닝';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['e','에러','실책이']::text[]))
  WHERE term = '실책';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['존이','스트라이크 존','s존']::text[]))
  WHERE term = '스트라이크존';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['패배투수','패전','패투']::text[]))
  WHERE term = '패전투수';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['승투','승리 투수','승리']::text[]))
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
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['프린차이즈','프렌차이즈','프랜차이즈가']::text[]))
  WHERE term = '프랜차이즈 스타';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['할','몇할','타할','n할','3할','4할','1할','2할','5할']::text[]))
  WHERE term = '할푼리';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['삼자번퇴가','삼자 번퇴']::text[]))
  WHERE term = '삼자범퇴';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['젖시타','적시타가','타점 적시타']::text[]))
  WHERE term = '적시타';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['수훈','오늘의 수훈선수']::text[]))
  WHERE term = '수훈선수';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['포지션','포지션 넘버','수비 위치','수비위치','야구 포지션']::text[]))
  WHERE term = '포지션 번호';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['바빕타','인플레이타율']::text[]))
  WHERE term = 'BABIP';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['게임차의','경기 게임차','순위 게임차']::text[]))
  WHERE term = '게임차';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['초구가','초구딱이']::text[]))
  WHERE term = '초구';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['보살이가','어시']::text[]))
  WHERE term = '보살';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['영구 결번이','결번']::text[]))
  WHERE term = '영구결번';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['베트 플립','베트플립','배트 플립']::text[]))
  WHERE term = '빠던';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['가중출루','가중 출루','wra']::text[]))
  WHERE term = 'wOBA';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['주요지표','야구 지표','기록 약자']::text[]))
  WHERE term = '세이버매트릭스';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['미트가','포수 글러브']::text[]))
  WHERE term = '포수 미트';
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
  SELECT string_agg(t, ', ') INTO missing FROM unnest(ARRAY['불펜','퍼펙트게임','삼진','보크','병살타','볼넷','유격수','지명타자','대타','대주자','포수','마무리투수','선발투수','등록말소','자동고의4구','피치클락','서스펜디드게임','벤치클리어링','퀄리티스타트','스윕','위닝시리즈','몸에 맞는 공','OPS','wRC+','WAR','WHIP','평균자책점','낫아웃','인필드플라이','신인드래프트','야수선택','희생플라이','희생번트','도루','타점','홈런','안타','2루타','3루타','타율','출루율','장타율','득점','이닝','실책','스트라이크존','패전투수','승리투수','포크볼','완투','홀드','세이브','샐러리캡','태그업','뜬공','땅볼','내야안타','자책점','쓰리피트','6-4-3 병살','프랜차이즈 스타','할푼리','삼자범퇴','적시타','수훈선수','포지션 번호','BABIP','게임차','초구','보살','영구결번','빠던','wOBA','세이버매트릭스','포수 미트','완봉','마운드','더그아웃','타순','엔트리','직선타','승률','위닝시리즈','타순','희생플라이','자책점','몸에 맞는 공','샐러리캡','포크볼','병살타','병살타']::text[]) AS t
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
  SELECT string_agg(t, ', ') INTO missing FROM unnest(ARRAY['야구','적시타','타수','타석','초구','볼카운트','헛스윙','루킹삼진','삼구삼진','1루타','밀어치기','당겨치기','어퍼스윙','레벨스윙','타자일순','장외홈런','인사이드더파크홈런','백투백','투런','쓰리런','좌전안타','중전안타','우전안타','좌중간안타','우중간안타','기습번트','쓰리번트','강공','버스터','페어','빠던','제구','구위','변화구','투나씽','볼배합','BABIP','wOBA','ISO','K/9','BB/9','K/BB','FIP','ERA+','OPS+','QS+','할푼리','실점','피안타','피홈런','게임차','10-10 클럽','30-30 클럽','보살','포지션 번호','6-4-3 병살','투수','1루수','2루수','3루수','좌익수','중견수','우익수','내야수','외야수','야수','홈스틸','주루','주루사','잔루','만루','무사','1사','잔루만루','유령주자','슬라이딩','고의낙구','포수보크','쓰리피트','4사구','스트레이트 볼넷','아웃카운트','1선발','선발 로테이션','필승조','추격조','터프세이브','투구수','피치컴','가을야구','영구결번','프랜차이즈 스타','옵트아웃','승요','허슬두','엘롯라시코','잠실시리즈','코시','불문율','호수비','본헤드 플레이','특타','시즌아웃','2차 드래프트','연고지','월드시리즈','WBC','상반기','루징시리즈','수훈선수','예고선발','DTD','타격감','거포','교타자','좌완','인플레이','송구','수비','출루','삼자범퇴','1/3이닝','야구공','라인업','베이스','무사 만루','스윙','세이버매트릭스','승패세홀','등번호','포수 미트','볼보이','메이저리그','아시아시리즈','섀도플레이','캐처플라이','스탯','도미넌트','발야구','삼구','마스크를 쓴다','4-6-3 병살','5-4-3 병살','20-20 클럽','40-40 클럽','파울플라이','무사 1루','2사 만루','희생타','우완','후반기','스플리터','병살']::text[]) AS t
  WHERE NOT EXISTS (SELECT 1 FROM public.baseball_terms bt WHERE bt.term = t AND bt.reviewed_at = DATE '2026-08-05');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '신규 용어가 적재되지 않았습니다(기존 행과 term 충돌 가능): %', missing;
  END IF;
END $$;

COMMIT;
