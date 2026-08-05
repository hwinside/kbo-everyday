-- ============================================================
-- 야잘알봇 검수 사전 확충 1차 (2026-08-05)
--
-- 근거: 운영 미답변 로그 1,075건 중 TERM 라벨 479건을 실측한 결과,
--       현재 사전 132종 + 기존 정규화로는 476건이 미매칭이었다.
--       (3건만 정규화로 잡혔고 나머지는 사전에 아예 없거나 표기가 달랐다)
--
-- 이 migration 이 하는 일:
--   ① 신규 용어 18종 삽입
--   ② 기존 용어에 alias 70건 보강 (오타·약어·구어 표기)
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
  ('1루타', ARRAY['일루타','single','단타']::text[], '타자가 안타를 치고 1루까지만 나간 거예요.
가장 기본이 되는 안타예요.
기록지에는 안타(H)로 함께 집계돼요.', 'batting', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
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
  ('실점', ARRAY['실점이','runs allowed']::text[], '투수가 마운드에서 내려간 뒤라도 자기가 내보낸 주자가 홈을 밟으면 그 투수의 실점이에요.
누가 마운드에 있었는지가 아니라 누가 그 주자를 내보냈는지로 따져요.
이 중 투수 책임인 것만 자책점이 돼요.', 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('보살', ARRAY['보살이','어시스트','assist']::text[], '수비수가 아웃을 만드는 과정에서 공을 던져 도운 기록이에요.
직접 아웃을 잡으면 자살(풋아웃), 도우면 보살이에요.
유격수·2루수에게 많이 쌓여요.', 'defense', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('쓰리피트', ARRAY['3피트','쓰리피트 라인','쓰리 피트','3피트 라인']::text[], '1루로 뛰는 주자가 정해진 주로를 벗어나 수비를 방해하면 아웃되는 규정이에요.
2025년부터 3피트 라인 안쪽뿐 아니라 1루 페어지역 안쪽 흙까지 달릴 수 있게 넓어졌어요.', 'rule', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('베이스', ARRAY['루','1루','일루','2루','이루','3루','삼루','누상']::text[], '1·2·3루에 놓인 사각형 흰색 백이에요.
KBO 경기장은 사방 45.72cm 크기를 써요.
주자가 이 백을 밟아야 진루로 인정돼요.', 'basic', 'official_rule', 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', '2026', DATE '2026-08-05'),
  ('희생타', ARRAY['희생 타','희생타가']::text[], '자기는 아웃되면서 주자를 다음 베이스로 보내거나 불러들이는 타격을 통틀어 부르는 말이에요.
번트로 보내면 희생번트(SH), 뜬공으로 불러들이면 희생플라이(SF)로 따로 기록해요.
둘 다 타수에는 빠져요.', 'record', 'official_record', 'https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', '2026', DATE '2026-08-05'),
  ('스플리터', ARRAY['스플릿','splitter','스플리터가']::text[], '검지와 중지를 벌려 잡고 던져 홈플레이트 앞에서 살짝 가라앉는 공이에요.
직구와 비슷한 속도로 오다 떨어져 헛스윙을 유도해요.
더 깊게 끼워 낙차를 키운 공은 포크볼이에요.', 'pitching', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05')
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
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['젖시타','적시타가','타점 적시타']::text[]))
  WHERE term = '적시타';
UPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['바빕타','인플레이타율']::text[]))
  WHERE term = 'BABIP';
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
  SELECT string_agg(t, ', ') INTO missing FROM unnest(ARRAY['불펜','퍼펙트게임','삼진','보크','병살타','볼넷','유격수','지명타자','대타','대주자','포수','마무리투수','선발투수','등록말소','자동고의4구','피치클락','서스펜디드게임','벤치클리어링','퀄리티스타트','스윕','위닝시리즈','몸에 맞는 공','OPS','wRC+','WAR','WHIP','평균자책점','낫아웃','인필드플라이','신인드래프트','야수선택','희생플라이','희생번트','도루','타점','홈런','안타','2루타','3루타','타율','출루율','장타율','득점','이닝','실책','스트라이크존','패전투수','승리투수','포크볼','완투','홀드','세이브','샐러리캡','태그업','뜬공','땅볼','내야안타','자책점','쓰리피트','적시타','BABIP','보살','wOBA','완봉','마운드','더그아웃','타순','엔트리','직선타','승률','위닝시리즈','타순','희생플라이','자책점','몸에 맞는 공','샐러리캡','포크볼','병살타','병살타']::text[]) AS t
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
  SELECT string_agg(t, ', ') INTO missing FROM unnest(ARRAY['적시타','타수','1루타','BABIP','wOBA','ISO','K/9','BB/9','K/BB','FIP','ERA+','OPS+','실점','보살','쓰리피트','베이스','희생타','스플리터']::text[]) AS t
  WHERE NOT EXISTS (SELECT 1 FROM public.baseball_terms bt WHERE bt.term = t AND bt.reviewed_at = DATE '2026-08-05');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '신규 용어가 적재되지 않았습니다(기존 행과 term 충돌 가능): %', missing;
  END IF;
END $$;

COMMIT;
