"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, ChevronRight, ChevronLeft, Trophy, Check } from "lucide-react";
import Link from "next/link";

interface Lesson {
  emoji: string;
  title: string;
  content: string;
  illustration: string;
}

const CHAPTERS = [
  {
    id: "basic",
    title: "⚾ 기초편",
    subtitle: "야구, 5분이면 충분해요",
    lessons: [
      { emoji: "🏟️", title: "야구의 목표", content: "아주 간단해요! 상대보다 점수(득점)를 더 많이 내면 이기는 겁니다.\n\n공을 던지는 팀(수비)과 공을 치는 팀(공격)이 번갈아가며 경기해요.", illustration: "⚾→🏃→🏠 = 1점!" },
      { emoji: "9️⃣", title: "이닝이란?", content: "야구는 9이닝으로 진행돼요.\n\n1이닝 = 공격팀이 아웃 3개 당하면 교대\n→ 양팀이 한 번씩 공격하면 1이닝 끝!\n\n9이닝이 끝났는데 동점이면? 연장전!", illustration: "1회→2회→...→9회\n초(원정)↔말(홈)" },
      { emoji: "🤾", title: "타자 vs 투수", content: "투수: 마운드에서 공을 던지는 사람\n타자: 홈플레이트 앞에서 공을 치는 사람\n\n투수는 타자를 아웃시키고 싶고,\n타자는 공을 쳐서 출루하고 싶어요!", illustration: "투수 🤾 ----⚾---→ 🧍 타자" },
      { emoji: "🎯", title: "스트라이크 & 볼", content: "스트라이크: 타자가 헛스윙하거나, 공이 존(strike zone)에 들어왔을 때\n볼: 존 바깥으로 빠진 공\n\n3스트라이크 → 삼진 아웃! ❌\n4볼 → 1루로 걸어 나감 (볼넷) ✅", illustration: "S S S → 삼진 아웃!\nB B B B → 볼넷 출루!" },
      { emoji: "💥", title: "안타의 종류", content: "안타: 타자가 공을 쳐서 베이스에 살아나가는 것\n\n1루타: 1루까지 📍\n2루타: 2루까지 📍📍\n3루타: 3루까지 📍📍📍\n홈런: 담장 넘김! 전원 홈으로 🎉", illustration: "홈런 = 담장 너머 = 최고의 순간! 🎆" },
    ],
  },
  {
    id: "intermediate",
    title: "📊 중급편",
    subtitle: "이것만 알면 해설이 들려요",
    lessons: [
      { emoji: "🧤", title: "9개 포지션", content: "1번 투수(P): 공 던지는 사람\n2번 포수(C): 공 받는 사람\n3번 1루수 / 4번 2루수\n5번 3루수 / 6번 유격수\n7번 좌익수 / 8번 중견수 / 9번 우익수\n\n+ DH(지명타자): 수비 안 하고 타격만!", illustration: "7️⃣  8️⃣  9️⃣\n 6️⃣ 4️⃣\n5️⃣     3️⃣\n  1️⃣\n  2️⃣" },
      { emoji: "🏃", title: "도루 & 희생번트", content: "도루: 투수가 던지는 틈에 다음 베이스로 달리기!\n→ 성공하면 진루, 실패하면 아웃\n\n희생번트: 공을 살짝 대서 주자를 진루시키기\n→ 타자는 아웃되지만 팀에 이득!", illustration: "도루 = 스피드의 예술 💨\n번트 = 작전의 미학 🎯" },
      { emoji: "📈", title: "핵심 스탯 3가지", content: "타율: 안타 ÷ 타수 (3할이면 엘리트!)\n→ .300 = 10번 중 3번 안타\n\nERA(평균자책점): 투수가 9이닝당 내주는 점수\n→ 3.00 이하면 에이스급!\n\nOPS: 출루율 + 장타율\n→ .800 이상이면 좋은 타자!", illustration: "타율 .300 = 🌟\nERA 3.00 = 🌟\nOPS .800 = 🌟" },
      { emoji: "⚡", title: "더블플레이 & 태그", content: "더블플레이(병살): 한 번에 아웃 2개!\n→ 수비 입장에선 최고, 공격은 최악 😱\n\n포스아웃: 베이스 밟으면 아웃\n태그아웃: 주자를 터치하면 아웃", illustration: "6→4→3 병살! ⚡⚡\n(유격수→2루수→1루수)" },
      { emoji: "🔄", title: "선발 · 중계 · 마무리", content: "선발투수: 경기 시작부터 던지는 투수 (보통 5~7이닝)\n중계투수(불펜): 선발 다음에 나오는 투수들\n마무리투수(클로저): 9회에 나와서 경기를 끝내는 투수\n\n세이브: 마무리가 리드를 지키면 기록!", illustration: "선발(1~6회) → 중계(7~8회) → 마무리(9회) 🔒" },
    ],
  },
  {
    id: "stadium",
    title: "🏟️ 직관편",
    subtitle: "첫 직관도 걱정 없어요",
    lessons: [
      { emoji: "📣", title: "응원 문화", content: "KBO만의 특별한 문화! 각 팀마다 고유 응원가가 있어요.\n\n타자가 타석에 들어서면 → 그 선수 응원가 시작!\n응원단장의 리드에 맞춰 다같이 노래하고 박수치기 🎶\n\n모르는 노래도 괜찮아요, 옆 사람 따라하면 됩니다!", illustration: "🎵 오~ 필승 코리아~ 🎵\n👏👏👏👏" },
      { emoji: "💃", title: "치어리더", content: "각 구단마다 전속 치어리더 팀이 있어요!\n\n이닝 사이사이에 공연을 하고,\n응원가에 맞춰 춤을 추면서 팬들을 이끌어요.\n\n인기 치어리더는 SNS 팔로워가 수십만!", illustration: "🩰 응원의 꽃! 🌸" },
      { emoji: "🎫", title: "좌석 고르기", content: "내야석: 경기가 잘 보여요! (가격 높음)\n외야석: 응원 분위기 최고! (가격 저렴)\n테이블석: 치맥하면서 관람 🍺\n잔디석: 피크닉 분위기 🌿\n\n💡 첫 직관이면 1루/3루 응원석 추천!\n열정적인 응원을 직접 느낄 수 있어요!", illustration: "1루 = 홈팀 응원석 🔥\n3루 = 원정팀 응원석" },
      { emoji: "🍗", title: "구장 먹거리", content: "야구장은 먹거리 천국!\n\n🍺 맥주: 직관의 필수템\n🍗 치킨: 매점에서 바로 구매\n🌭 핫도그: 간편 간식\n🍕 피자: 테이블석이면 배달도!\n\n💡 구장 밖 먹자골목도 꼭 가보세요!\n→ 크보팬 구장 가이드 참고 😉", illustration: "🍺 + 🍗 + ⚾ = 행복 🎉" },
      { emoji: "📱", title: "직관 꿀팁", content: "✅ 우천 시 비닐 판초 준비\n✅ 방석 가져가면 엉덩이 편함\n✅ 보조배터리 필수 (폰 많이 씀)\n✅ 자외선 차단제 (주간경기)\n✅ 경기 1시간 전 도착 (연습 구경)\n✅ 크보팬 앱 켜놓기! 😎\n\n❌ 레이저포인터, 호루라기 금지!", illustration: "준비물 체크리스트 ✅✅✅" },
    ],
  },
  {
    id: "advanced",
    title: "🔬 심화편",
    subtitle: "세이버메트릭스로 야구를 더 깊게",
    lessons: [
      { emoji: "📐", title: "세이버메트릭스란?", content: "전통 스탯(타율, ERA)만으로는 선수의 진짜 실력을 알기 어려워요.\n\n세이버메트릭스(SABRmetrics)는 야구를 통계학으로 분석하는 학문이에요.\n\n영화 \<머니볼\>에서 유명해진 그것! 🎬\n\n핵심 철학: \"눈에 보이는 것보다 숫자가 진실에 가깝다\"", illustration: "전통: 타율 .300 = 좋은 타자?\n세이버: 진짜 기여도는 다를 수 있다!" },
      { emoji: "🎯", title: "OPS (출루율+장타율)", content: "OPS = OBP(출루율) + SLG(장타율)\n\n출루율(OBP): 타석에서 얼마나 자주 출루하나\n→ 안타 + 볼넷 + 몸맞공 포함\n\n장타율(SLG): 안타의 질이 얼마나 좋은가\n→ 2루타=2, 홈런=4로 계산\n\n🏆 OPS 기준:\n.900+ = MVP급 🌟\n.800+ = 올스타급\n.700+ = 평균 이상\n.600 이하 = 부진", illustration: "OBP .380 + SLG .520\n= OPS .900 🌟" },
      { emoji: "📊", title: "wRC+ (가중 득점 생산력)", content: "wRC+는 타자의 종합 공격력을 하나의 숫자로!\n\n100 = 리그 평균\n150 = 평균보다 50% 더 잘 침\n70 = 평균보다 30% 못 침\n\n구장, 리그 환경까지 보정해서\n가장 공정한 타자 비교 지표예요.\n\n\"이 선수가 진짜 얼마나 잘 치나?\"의 답!", illustration: "wRC+ 150 = 엘리트 🏆\nwRC+ 100 = 평균\nwRC+ 70 = 부진 📉" },
      { emoji: "🔥", title: "WHIP (이닝당 출루 허용)", content: "WHIP = (볼넷 + 피안타) ÷ 이닝 수\n\n투수가 이닝당 얼마나 주자를 내보내는가?\n\n🏆 WHIP 기준:\n1.00 이하 = 에이스급 🌟\n1.00~1.20 = 우수\n1.20~1.40 = 평균\n1.40+ = 부진\n\nERA는 운에 영향을 많이 받지만,\nWHIP는 투수의 실제 제구력을 보여줘요.", illustration: "(안타 100 + 볼넷 30) ÷ 이닝 180\n= WHIP 0.72 🌟" },
      { emoji: "⚡", title: "FIP (수비 무관 평균자책)", content: "FIP = 투수 본인 실력만 측정!\n\n삼진, 볼넷, 홈런만으로 계산\n→ 수비수가 못 잡은 안타는 빼줌\n\nERA와 FIP 차이가 크면?\n→ ERA < FIP: 운이 좋았음 (수비 도움)\n→ ERA > FIP: 운이 나빴음 (실력은 좋음)\n\n\"진짜 잘 던지는 투수\"를 찾는 핵심 지표!", illustration: "ERA 2.50 / FIP 3.80\n= 운이 좋았던 시즌 🍀\n\nERA 4.00 / FIP 3.00\n= 실력은 좋은데 불운 😤" },
      { emoji: "🏃", title: "WAR (대체 선수 대비 승리 기여)", content: "WAR = 이 선수가 없으면 팀이 몇 승을 덜 할까?\n\n야구 세이버메트릭스의 최종 보스!\n공격 + 수비 + 주루 + 투구를 모두 합산\n\n🏆 시즌 WAR 기준:\n8+ = MVP 🏆\n5+ = 올스타 ⭐\n2+ = 주전급\n0~2 = 백업\n마이너스 = 차라리 안 쓰는 게...\n\nMVP 투표는 거의 WAR 순위와 일치!", illustration: "WAR 8.5 = 시즌 MVP 🏆\n\"이 선수 혼자 8.5승의 가치\"" },
      { emoji: "🎲", title: "BABIP (인플레이 타구 안타율)", content: "BABIP = 타구가 페어 지역에 갔을 때 안타가 될 확률\n\n리그 평균은 항상 약 .300\n\n타자 BABIP .380 → 운이 좋았을 수 있음\n타자 BABIP .230 → 운이 나빴을 수 있음\n\n\"이 타자/투수의 성적이 진짜인가?\"\n→ BABIP이 극단적이면 조만간 평균으로 돌아올 확률 높음!\n(회귀의 법칙)", illustration: "BABIP .380 → 📈 곧 하락할 수도\nBABIP .220 → 📉 곧 반등할 수도\n평균 = .300 (마법의 숫자)" },
      { emoji: "🧮", title: "실전 활용법", content: "이 지표들을 어디서 확인하나요?\n\n✅ 크보팬 선수 스탯 (네이버보다 상세!)\n✅ 스탯티즈(Statiz) — KBO 세이버 전문\n\n활용 예시:\n\n\"타율은 높은데 왜 평가가 낮지?\"\n→ BABIP 확인 (운인지 실력인지)\n\n\"ERA가 낮으면 무조건 좋은 투수?\"\n→ FIP 비교 (수비 도움 빼면?)\n\n\"MVP는 누구?\"\n→ WAR 순위 확인!", illustration: "세이버 3대장:\n타자 = wRC+\n투수 = FIP\n종합 = WAR" },
    ],
  },
  {
    id: "kbo",
    title: "🏆 KBO편",
    subtitle: "10개 구단의 역사와 2026 시즌 전력",
    lessons: [
      { emoji: "🦁", title: "삼성 라이온즈", content: "창단: 1982년 (KBO 원년 멤버)\n연고지: 대구 | 구장: 대구삼성라이온즈파크 (2016~)\n우승: 8회 (1985, 2002, 2005, 2006, 2011, 2012, 2013, 2014)\n\n📜 역사:\n삼성그룹이 창단한 KBO의 명문. 초대 감독은 서정철.\n80년대는 중위권이었지만, 2000년대 들어 황금기 시작.\n2011~2014 사상 초유의 4연패! KBO 역사상 유일무이한 기록.\n\n🌟 레전드:\n• 이승엽 — 아시아 홈런왕. 1999년 시즌 54홈런(당시 아시아 신기록). 통산 467홈런. 일본 진출 후에도 활약. 한국 야구의 상징.\n• 양준혁 — 미스터 삼성. 통산 타율 .313, 2,318안타. 은퇴경기에서 홈런 치고 울던 장면은 KBO 역사 명장면.\n• 이병규 — 보이지 않는 손. 수비의 신. 2001년 골든글러브 외야수.\n• 마해영 — 통산 타율 .317. 2루타의 제왕. 조용하지만 꾸준한 삼성맨.\n\n🔥 TMI:\n• \"삼성은 가을에 강하다\" — 2000년대 플레이오프 승률이 비현실적\n• 대구 팬들의 자부심이 대단. 라이온즈 우승 퍼레이드에 100만명 모인 적 있음\n• 삼성 유니폼의 파란색은 삼성그룹 CI와 동일\n• 4연패 시절 핵심: 더스틴 니퍼트(외국인 에이스) + 최형우 + 이승엽\n• 라이온즈파크는 KBO 구장 중 관중 접근성 최고 (지하철 바로 연결)\n\n📊 2026 전력분석:\n• 구자욱이 타선의 중심. 2024시즌 타율 .320+ 기록\n• 김영웅, 김지찬 등 젊은 피 성장 중\n• 투수진 재건이 최대 과제 — 에이스급 부재\n• 외국인 선수 성적이 시즌 좌우할 전망\n• 목표: 포스트시즌 진출 + 과거 영광 재현\n\n🎵 공식 응원가:\n• 「승리의 노래」 — \"삼성~ 라이온즈~ 승리를 향해~\"\n• 「우리는 챔피언」 — 우승 시즌마다 울려퍼지는 노래\n• 구자욱 개인 응원가 — \"구자욱 구자욱 자~ 욱~\"\n📺 https://www.youtube.com/results?search_query=삼성+라이온즈+응원가", illustration: "🏟️ 대구삼성라이온즈파크\n🏆🏆🏆🏆🏆🏆🏆🏆\n4연패(2011-2014) 전무후무!" },
      { emoji: "🐻", title: "두산 베어스", content: "창단: 1982년 (OB 베어스 → 1999 두산)\n연고지: 서울 잠실 (3루) | 구장: 잠실야구장\n우승: 6회 (1982, 1995, 2001, 2015, 2016, 2019)\n\n📜 역사:\nKBO 원년 초대 챔피언! OB 베어스 시절 1982년 첫 한국시리즈 우승.\n90년대 암흑기를 겪다가 두산으로 바뀐 뒤 다시 강팀으로.\n2015~2019 사이 3번 우승. \"가을의 팀\" 별명 획득.\n\n🌟 레전드:\n• 김동주 — \"미스터 두산\". 통산 286홈런. 두산의 4번타자 상징. 은퇴 후에도 해설위원으로 인기.\n• 김현수 — 볼넷의 신. 출루율 괴물. MLB 볼티모어에서도 활약. 선구안이 역대급.\n• 박철순 — OB 시절 에이스. 1982년 원년 우승 주역.\n• 김재환 — 2019 우승 핵심 4번타자. 홈런+타점 2관왕.\n\n🔥 TMI:\n• 잠실 3루는 두산 홈. 1루 LG와 같은 구장 공유 (세계적으로도 드문 케이스)\n• \"두산은 가을에 온다\" — 정규시즌 4위여도 한국시리즈에서 우승하는 마법\n• 2015 한국시리즈: 정규시즌 5위에서 와일드카드→준플→플옵→한시 올킬!\n• 두산 팬들의 응원가 \"승리의 노래\"는 KBO에서 가장 유명한 팀 응원가 중 하나\n• OB 맥주 후원 시절에는 구장에서 OB 라거 무한리필 이벤트도 했었음\n• 양의지는 두산의 심장. 포수+리더+타격까지 되는 프랜차이즈 스타\n\n📊 2026 전력분석:\n• 김하성 KBO 복귀! MLB 샌디에이고에서 돌아온 내야의 핵심\n• 양의지 베테랑 포수의 리더십 여전\n• 젊은 투수진(곽빈, 김택연) 성장세 고무적\n• 전통의 가을야구 DNA — 올해도 가을엔 무서울 팀\n\n🎵 공식 응원가:\n• 「OB 베어스 응원가」 — 원년부터 이어온 전통 응원가\n• 「돌아와요 부산항에」 개사 버전 — 잠실 3루의 클래식\n• 양의지 개인 응원가 — 가장 인기 있는 개인 응원가 중 하나\n📺 https://www.youtube.com/results?search_query=두산+베어스+응원가", illustration: "🏟️ 잠실야구장 (3루)\n🏆 초대 챔피언 + 가을의 팀\n🐻 곰은 가을에 깨어난다" },
      { emoji: "🦅", title: "한화 이글스", content: "창단: 1986년 (빙그레 이글스 → 1994 한화)\n연고지: 대전 | 구장: 한화생명이글스파크\n우승: 1회 (1999)\n\n📜 역사:\n1986년 빙그레 이글스로 출발. 1994년 한화그룹 인수.\n1999년 유일한 한국시리즈 우승! 송진우의 전설적인 투구.\n이후 20년 넘게 우승 없이 하위권... 하지만 팬 충성도는 KBO 최상위급.\n\n🌟 레전드:\n• 장종훈 — 통산 .307, 한화의 전설적 타자. 1999년 우승의 핵심.\n• 류현진 — 한화 출신 메이저리거! 2006년 고졸 신인으로 18승. LA 다저스에서 사이영상 2위. 한국 야구의 자랑.\n• 김태균 — \"대전의 아들\". 통산 300홈런 클럽. 일본 치바롯데에서도 활약. 은퇴 후 해설위원.\n• 송진우 — 1999 한국시리즈 MVP. 그 해 가을의 영웅.\n• 정우람 — 마무리 투수. \"대전의 수호신\". 통산 200세이브+.\n\n🔥 TMI:\n• \"꺾이지 않는 마음\" — 한화 팬들의 슬로건. 만년 하위권이어도 팬이 줄지 않는 기적\n• 대전 이글스파크 치킨 거리는 직관 명소. 경기 전 치맥 필수 코스\n• 한화 팬은 자학 드립의 달인. \"한화는 0순위\" 밈이 유명\n• 2023년 시즌 중 \"꺾이지 않는 마음\" 밈이 전국적으로 유행, 팬 유입 폭증\n• 류현진이 한화에서 뛰던 시절 대전 구장이 매일 매진\n• 빙그레 시절 유니폼이 레트로로 다시 인기\n• 한화 팬들 사이에서 \"우승하면 대전 시내 퍼레이드\" 소원이 있음 (26년째 대기 중...)\n\n📊 2026 전력분석:\n• 문동주 — KBO 차세대 에이스. 150km+ 강속구 + 날카로운 슬라이더\n• 노시환 장타력 건재. 30홈런급 파워\n• FA 영입으로 전력 보강 완료\n• 류현진 은퇴 후 투수 리더십 공백이 과제\n• 팬들의 염원: 제발 포스트시즌만이라도!\n\n🎵 공식 응원가:\n• 「독수리 행진곡」 — 한화의 대표 응원가\n• 「꺾이지 않는 마음」 — 팬들의 비공식 국가(?)\n• 문동주 개인 응원가 — 등판할 때마다 대전이 흔들림\n📺 https://www.youtube.com/results?search_query=한화+이글스+응원가", illustration: "🏟️ 한화생명이글스파크\n🏆 x1 (1999... 돌아와요 우승)\n🧡 꺾이지 않는 마음 💪" },
      { emoji: "🐯", title: "KIA 타이거즈", content: "창단: 1982년 (해태 타이거즈 → 2001 KIA)\n연고지: 광주 | 구장: 광주-기아 챔피언스 필드 (2014~)\n우승: 11회 (해태 9 + KIA 2) — 통합 최다!\n\n📜 역사:\n해태 타이거즈는 KBO의 레전드. 80~90년대 최강 왕조.\n1986~1989 전무후무 4연패(삼성보다 먼저!), 1991, 1993, 1996, 1997까지 90년대 4번 우승.\n2001년 KIA 자동차 인수. 2009년, 2017년 한국시리즈 우승.\n2024년 통합우승으로 명가 부활!\n\n🌟 레전드:\n• 선동열 — \"부산의 태양\". 통산 ERA 1.20(!!!) 세계 프로야구 역대 최고 방어율. 1985년 24승 4패. 인간이 아닌 존재.\n• 이종범 — \"바람의 아들\". 도루왕. 1994년 타율 .393(!). 한국시리즈에서 혼자 팀을 캐리하던 모습은 전설.\n• 이대호 — 해태 유스 출신은 아니지만, KIA의 자존심이었던 시절.\n• 최형우 — \"형우형\". 삼성에서 KIA로 FA 이적. 빅리그급 선구안.\n\n🔥 TMI:\n• 해태 타이거즈 시절 광주 무등경기장은 \"호남의 성지\"\n• 선동열 vs 최동원(롯데) 라이벌리는 KBO 역사상 최고의 라이벌전\n• 해태제과가 모기업이라 우승하면 아이스크림 무료 배포했었음 🍦\n• 1997년 외환위기로 해태그룹 부도 → 팀 매각 위기 → 광주 시민 눈물\n• 챔피언스 필드는 KBO 최고 구장 중 하나. 잔디, 시설, 접근성 모두 최상\n• 김도영은 고졸 2년차에 30-30(30홈런+30도루) 달성. 역대급 스타 탄생\n• \"호랑이 기운이 솟아나요\" 응원가는 KBO에서 가장 파워풀\n\n📊 2026 전력분석:\n• 김도영 — 이미 슈퍼스타. 타격+수비+주루 삼박자. MVP 후보 1순위\n• 양현종 — 40대에도 던지는 리빙레전드. 200승 도전\n• 안우진 — KBO 최고 구위. 150km+ 직구 + 체인지업 조합\n• 최형우 — 은퇴 카운트다운이지만 여전한 존재감\n• 2024 우승 핵심 멤버 대부분 잔류. 2연패 노린다!\n\n🎵 공식 응원가:\n• 「해태 타이거즈 응원가」 — \"호랑이 기운이 솟아나요~\" 원조 레전드\n• 「KIA 챔피언스」 — 챔피언스필드 개장 이후 신곡\n• 김도영 개인 응원가 — 광주가 떠나갈 듯한 함성\n📺 https://www.youtube.com/results?search_query=KIA+타이거즈+응원가", illustration: "🏟️ 광주-기아 챔피언스필드\n🏆🏆🏆🏆🏆🏆🏆🏆🏆🏆🏆\n통합 11회 = KBO 최다!" },
      { emoji: "⚡", title: "LG 트윈스", content: "창단: 1982년 (MBC 청룡 → 1990 LG 트윈스)\n연고지: 서울 잠실 (1루) | 구장: 잠실야구장\n우승: 3회 (1990, 1994, 2023)\n\n📜 역사:\nMBC 청룡으로 시작. 1990년 LG그룹 인수와 동시에 한국시리즈 우승!\n1994년 두 번째 우승 후... 29년간의 기나긴 가뭄.\n2023년 드디어 한국시리즈 우승!! 29년 만의 감격. 잠실이 눈물바다.\n\n🌟 레전드:\n• 박용택 — \"잠실의 황태자\". 통산 2,504안타(역대 1위). LG 한 팀에서 22시즌. 원클럽맨의 상징.\n• 이병규 — LG→삼성→LG. 황금 외야수. MLB 시카고 컵스에서도 뛴 코리안 레전드.\n• 이상훈 — MBC→LG 좌완 에이스. 통산 승수 KBO 상위권.\n• 봉중근 — 강속구 투수. 인기도 실력도 최고였던 좌완.\n\n🔥 TMI:\n• \"LG는 1루\" — 잠실야구장 1루가 LG 홈. 3루 두산과 경기날이면 \"잠실 더비\"\n• 29년간 우승 못하면서 생긴 밈: \"엘망진창\", \"내년엔 되겠지\"\n• 2023년 우승 순간 잠실 밖에서도 함성이 들렸다는 증언 다수\n• 우승 퍼레이드에 50만명 이상 운집. 서울 강남 일대 마비\n• 엘팬들은 자조적 유머의 달인이었지만, 우승 후 \"우리가 해냈다\" 자부심 폭발\n• 오스틴은 LG 역대 최고 외국인 타자 중 한 명. 팬들 사이 \"오빠\"로 불림\n• 잠실 1루 치어리더 응원이 KBO에서 가장 화려하다는 평가\n\n📊 2026 전력분석:\n• 오스틴 — 핵심 4번타자. 장타력+출루율 모두 최상급\n• 임찬규 — 좌완 에이스. 꾸준한 이닝이터\n• 고우석 — 마무리 철벽. 150km+ 직구로 9회를 잠금\n• 박동원 — 안정적 포수. 투수 리드 + 타격 겸비\n• 2023 우승 경험이 팀 자신감으로. 왕조 구축 가능성!\n\n🎵 공식 응원가:\n• 「LG 트윈스 응원가」 — \"엘~지~ 트윈스~ 오~ 필승~\"\n• 「서울의 빛」 — 잠실 1루를 밝히는 노래\n• 오스틴 개인 응원가 — \"오~ 오스틴~ 오오오~ 오스틴~\"\n• 고우석 개인 응원가 — 9회에 울려퍼지면 승리 확정 느낌\n📺 https://www.youtube.com/results?search_query=LG+트윈스+응원가", illustration: "🏟️ 잠실야구장 (1루)\n🏆🏆🏆\n29년의 기다림... 그리고 2023! ⚡" },
      { emoji: "🕊️", title: "롯데 자이언츠", content: "창단: 1982년 (KBO 원년)\n연고지: 부산 | 구장: 사직야구장\n우승: 2회 (1984, 1992)\n\n📜 역사:\n부산의 자존심! KBO 원년부터 부산을 대표하는 팀.\n80~90년대 최동원이라는 전설과 함께 전성기.\n1992년 이후 30년 넘게 우승 없지만, 팬 열정은 KBO 1위.\n\n🌟 레전드:\n• 최동원 — \"부산의 아들\". KBO 역사상 최고의 투수로 불림. 1984년 한국시리즈에서 4일간 3경기 등판(!) 전설의 투혼. 2011년 별세.\n• 가르시아 — 역대 최고 외국인 타자. 통산 타율 .339. 2001년 시즌 타율 .388(!). 사직구장의 황제.\n• 전준우 — 현역 레전드. 통산 200홈런+. 롯데 생활 15년+ 충성파.\n• 이대호 — 부산 출신 롯데 4번타자 → MLB 시애틀 → 일본 소뱅 → 롯데 복귀. \"부산의 아이콘\".\n\n🔥 TMI:\n• 사직구장 응원 문화는 KBO 최고! \"부산 갈매기\" 응원가를 모르면 간첩\n• 사직 야구장 주변 돼지국밥+소주 콤보는 직관의 정석\n• 롯데 팬들은 KBO에서 원정 동원력도 1위. 전국 어디든 갈매기 물결\n• \"1992년 이후 우승 없음\"은 한화와 함께 KBO의 양대 한(恨)\n• 최동원 추모 행사가 매년 사직에서 열림. 영구결번 #11\n• 부산 자체가 야구 도시. 초등학생도 롯데팬인 집이 대부분\n• 사직 치어리더 응원과 비치발리볼 이벤트는 전국구 인기\n• 이대호의 은퇴식 때 사직 만원관중 + 부산 시내 전광판 생중계\n\n📊 2026 전력분석:\n• 한석현 — 차세대 외야 스타. 스피드+타격\n• 전준우 — 베테랑의 마지막 불꽃. 통산 기록 도전\n• 투수진 보강이 만년 과제. 에이스 등장이 절실\n• 사직 팬들의 응원은 12번째 선수. 홈 승률 항상 높음\n• \"올해는 되겠지\" — 부산의 영원한 희망\n\n🎵 공식 응원가:\n• 「부산 갈매기」 — KBO 전체 응원가 중 인지도 1위! \"부~산 갈매기~ 부산 갈매기~\" 상대팀 팬도 다 알고 있음\n• 「롯데 자이언츠 응원가」 — 사직의 함성\n• 전준우 개인 응원가 — 사직의 살아있는 역사\n📺 https://www.youtube.com/results?search_query=롯데+자이언츠+부산갈매기", illustration: "🏟️ 사직야구장\n🏆🏆 (1984, 1992)\n🎵 부~산 갈매기~ 🕊️" },
      { emoji: "🦸", title: "키움 히어로즈", content: "창단: 2008년 (서울 히어로즈 → 넥센 → 키움)\n연고지: 서울 구로 | 구장: 고척스카이돔\n우승: 0회 (한국시리즈 준우승 2019, 2024)\n\n📜 역사:\n현대 유니콘스 해체 후 선수단을 인수받아 창단.\n모기업 없이 시작한 \"시민구단\"의 기적.\n넥센 타이어, 키움증권 등 스폰서가 바뀌어도 꾸준히 경쟁력 유지.\n2014년 한국시리즈 첫 진출, 2019·2024년 준우승.\n\n🌟 레전드:\n• 박병호 — \"대포\". 통산 400홈런+. 넥센 시절 시즌 53홈런(역대 2위). MLB 미네소타에서도 활약.\n• 이정후 — \"정후 is 뭔들\". 2022 타격왕 + MVP. 골든글러브 외야수. SF 자이언츠 진출.\n• 서건창 — \"범인(凡人)의 야구\". 안타 제조기. 2014년 200안타(시즌 최다).\n• 이용규 — 테이블세터의 정석. 출루의 달인.\n\n🔥 TMI:\n• 고척스카이돔은 국내 유일 돔구장. 비 와도 경기 가능! 하지만 접근성이...\n• \"목동 시절\"을 그리워하는 올드팬 많음 (목동야구장 → 고척돔 이전)\n• 모기업 없는 시민구단이라 재정이 빠듯. FA 대어를 놓치는 경우가 많음\n• 그래서 육성에 집중 → 박병호, 이정후, 서건창 등 드래프트 성공 사례 다수\n• \"키움 = 메이저리그 사관학교\" 별명. 키운 선수를 MLB에 보내는 구조\n• 2019 한국시리즈에서 두산에게 패배. 팬들 사이 \"그 4차전\"은 금기어\n• 고척돔 먹거리가 갈수록 좋아지고 있음. 돔 안 BBQ 치킨 인기\n\n📊 2026 전력분석:\n• 이정후 MLB 복귀 후 재적응 시즌\n• 이의리 — 좌완 유망주. 150km+ 강속구\n• 젊은 타선 중심 공격력은 상위권\n• 불펜 안정화가 관건\n• 한국시리즈 우승 0회의 설움을 풀 수 있을까?\n\n🎵 공식 응원가:\n• 「히어로즈 응원가」 — 고척돔 울림이 독특\n• 「Victory」 — 승리 후 떼창곡\n• 이정후 개인 응원가 — \"이정후 이정후 짠~\"\n📺 https://www.youtube.com/results?search_query=키움+히어로즈+응원가", illustration: "🏟️ 고척스카이돔\n🥈 준우승만 2번... 올해는?!\n🦸 모기업 없는 시민구단의 기적" },
      { emoji: "🦕", title: "NC 다이노스", content: "창단: 2013년 (KBO 9번째 구단)\n연고지: 창원 | 구장: 창원NC파크 (2019~)\n우승: 1회 (2020)\n\n📜 역사:\nNC소프트(게임회사) 김택진 대표가 창단.\n2013년 KBO 합류, 2020년 창단 8년 만에 한국시리즈 우승!\nIT 기업답게 데이터 야구의 선두주자.\n\n🌟 레전드:\n• 나성범 — NC의 상징. 2020 한국시리즈 MVP. 국보급 외야수. 강한 어깨+장타력.\n• 박민우 — \"민우세권\". 유격수/외야수. 수비 범위가 어마어마. 골든글러브 단골.\n• 에릭 테임즈 — NC 초창기 외국인. 시즌 47홈런. 이후 MLB 밀워키에서도 활약.\n• 구창모 — NC 자체 육성 에이스. 좌완의 정석.\n\n🔥 TMI:\n• NC소프트 = 리니지 만든 회사. 야구팀 운영에도 게임 밸런싱 기법 적용한다는 소문\n• 창원NC파크는 2019년 개장. KBO 최신 구장. 관중석에서 경남 바다 보임\n• 김택진 대표가 직접 경기 관람 자주 옴. 구단주 중 팬 친화적\n• NC 팬 = \"엔팬\". 창단 역사가 짧아서 젊은 팬 비율 높음\n• 2020 코로나 시즌에 우승. 관중 제한으로 기쁨을 함께 나누지 못한 아쉬움\n• NC 유니폼 디자인이 세련됨. KBO에서 가장 \"힙\"하다는 평가\n• 데이터실이 KBO 구단 중 가장 크다는 얘기가 있음 (IT 기업 DNA)\n• 마산구장 시절(2013~2018)의 추억을 간직한 올드 엔팬도 있음\n\n📊 2026 전력분석:\n• 나성범 여전히 타선의 중심. 하지만 나이가...\n• 소형준 좌완 에이스로 확실히 자리매김\n• 신인 유망주 풍부. 팜 시스템 KBO 상위권\n• 데이터 기반 작전으로 \"머니볼\" 스타일 경영\n• 우승 경험 + 젊은 전력 = 다크호스\n\n🎵 공식 응원가:\n• 「NC 다이노스 응원가」 — \"NC~ 다이노스~ 위대한 승리~\"\n• 「창원의 별」 — NC파크 개장곡\n• 나성범 개인 응원가 — 창원의 자존심\n📺 https://www.youtube.com/results?search_query=NC+다이노스+응원가", illustration: "🏟️ 창원NC파크\n🏆 2020 창단 8년 만의 우승!\n🦕 IT + 야구 = 데이터 다이노스" },
      { emoji: "🔴", title: "SSG 랜더스", content: "창단: 2000년 (SK 와이번스 → 2021 SSG)\n연고지: 인천 | 구장: 인천SSG랜더스필드\n우승: 5회 (2007, 2008, 2010, 2011, 2022) — SK 시절 포함\n\n📜 역사:\nSK텔레콤이 창단한 SK 와이번스. 2000년대 후반 황금기.\n2007~2011 사이 4번 우승! \"인천의 왕조\".\n2021년 신세계그룹 인수 → SSG 랜더스로 재탄생.\n2022년 새 이름으로 첫 해에 바로 우승! 영화 같은 스토리.\n\n🌟 레전드:\n• 박재홍 — SK 초대 에이스. 1999년 데뷔, 통산 150승+. 인천의 전설.\n• 김광현 — \"광현이형\". KBO 좌완 최고. MLB 세인트루이스 진출. SK/SSG 프랜차이즈 스타.\n• 최정 — \"레전드 3루수\". 통산 홈런 KBO 역대 1위 도전 중! 400홈런+. 한 팀 20년+.\n• 나주환 — SK 왕조 시절 핵심 타자.\n• 김재현 — 2022 한국시리즈 MVP.\n\n🔥 TMI:\n• SSG = 신세계그룹. 인수 후 구장 리모델링에 대규모 투자. 편의시설 KBO 최고\n• \"랜더스 필드\"에는 이마트 트레이더스 식품관이 있음(!). 구장에서 장보기 가능\n• 최정의 홈런 세리머니 \"빠던\" (배트 던지기)는 KBO 대표 세리머니\n• SK 시절 인천 문학경기장 → 현재 랜더스필드로 이전. 시설 차이가 압도적\n• 2022 우승 때 인천 시민 퍼레이드. SSG 1년차에 우승은 \"신세계급\" 드라마\n• 김광현이 MLB 갔다 돌아올 때 인천공항에 팬 수백명 마중\n• 정용진 부회장이 직접 시구하는 등 구단주 노출 적극적\n\n📊 2026 전력분석:\n• 최정 — 통산 홈런 기록 경신 중. 살아있는 전설\n• 페르난데스 외국인 에이스급 투수\n• 두터운 선수층. 1군~2군 전력 모두 탄탄\n• 구단 투자 의지 확실 (신세계 자본)\n• 매년 우승 후보. 2026도 예외 아님\n\n🎵 공식 응원가:\n• 「SSG 랜더스 응원가」 — 신세계급 퀄리티 응원가\n• 「SK 와이번스 응원가」 — 올드팬은 아직 이 버전 부름\n• 최정 개인 응원가 — 홈런 치면 \"빠던\" + 응원가 떼창\n📺 https://www.youtube.com/results?search_query=SSG+랜더스+응원가", illustration: "🏟️ 인천SSG랜더스필드\n🏆🏆🏆🏆🏆\n최정 = 🇰🇷 홈런왕 레전드" },
      { emoji: "🧙", title: "KT 위즈", content: "창단: 2015년 (KBO 10번째 구단, 현 10구단 체제 완성)\n연고지: 수원 | 구장: 수원KT위즈파크\n우승: 1회 (2021)\n\n📜 역사:\nKT(구 KTF)가 창단한 KBO 막내. 2015년 합류.\n초창기 최하위를 전전하다가, 2021년 창단 7년 만에 한국시리즈 우승!\n\"꼴찌에서 챔피언까지\" 드라마틱한 성장 스토리.\n\n🌟 레전드:\n• 강백호 — KT의 프랜차이즈 스타. 고졸 신인으로 바로 4번타자. 2021 우승 핵심.\n• 황재균 — 2017 WBC 국가대표. KT에서 전성기. 이후 롯데 이적.\n• 쿠에바스 — 2021 한국시리즈 MVP. 외국인 투수 역대급 시즌.\n• 로하스 — 2021 정규시즌 MVP. 타격 3관왕.\n\n🔥 TMI:\n• KT = 통신회사. 구장 내 5G 와이파이가 빵빵함 (당연?)\n• 수원 위즈파크는 원래 수원 종합운동장 야구장을 리모델링\n• 2015년 첫 시즌 42승 101패. 역대급 꼴찌. 그때부터 응원한 팬 = 진정한 케팬\n• 6년 만에 꼴찌→우승. KBO 역사상 가장 빠른 성장\n• \"수원 시민구단\" 느낌이 강함. 수원 지역 축제와 연계 이벤트 많음\n• KT 위즈파크 불꽃놀이 이벤트가 유명. 경기 끝나고 불꽃 쏘는 날은 만원\n• 강백호 응원가가 KBO에서 가장 중독성 있다는 평가 다수\n• 2021 우승 퍼레이드에 수원 화성 행궁 앞에서 행사. 역사+야구 콜라보\n\n📊 2026 전력분석:\n• 강백호 여전한 핵심 타자. 30홈런급 파워\n• 외국인 투수 영입이 매 시즌 관건\n• 젊은 선수 육성 시스템 가동 중\n• 수원 팬 베이스 꾸준히 성장\n• 2021 우승 멤버 이탈이 아쉽지만, 새로운 도전\n\n🎵 공식 응원가:\n• 「KT 위즈 응원가」 — \"KT~ 위즈~ 승리를 향해~\"\n• 「수원의 마법」 — 2021 우승 시즌 테마곡\n• 강백호 개인 응원가 — KBO 최고 중독성. \"강백호~ 강백호~\" 계속 맴돔\n📺 https://www.youtube.com/results?search_query=KT+위즈+응원가", illustration: "🏟️ 수원KT위즈파크\n🏆 2021 꼴찌→챔피언!\n🧙 7년 만의 마법" },
    ],
  },
];

export default function LearnPage() {
  const [selectedChapter, setSelectedChapter] = useState<string | null>(null);
  const [lessonIndex, setLessonIndex] = useState(0);
  const [completed, setCompleted] = useState<Set<string>>(new Set());

  const chapter = CHAPTERS.find(c => c.id === selectedChapter);

  function handleComplete() {
    if (chapter) {
      setCompleted(prev => new Set(prev).add(chapter.id));
      setSelectedChapter(null);
      setLessonIndex(0);
    }
  }

  return (
    <div className="min-h-screen bg-bg-primary pb-24">
      <header className="px-5 py-5">
        {selectedChapter ? (
          <button onClick={() => { setSelectedChapter(null); setLessonIndex(0); }} className="flex items-center gap-1 text-text-secondary mb-2">
            <ArrowLeft size={20} />
            <span className="text-sm">목록으로</span>
          </button>
        ) : (
          <>
            <h1 className="text-xl font-bold text-text-primary">⚾ 야구 쉽게 배우기</h1>
            <p className="text-sm text-text-tertiary mt-1">처음이어도 괜찮아요, 5분이면 충분!</p>
          </>
        )}
      </header>

      {/* Chapter list */}
      {!selectedChapter && (
        <div className="px-5 space-y-4">
          {CHAPTERS.map((ch) => {
            const isDone = completed.has(ch.id);
            return (
              <motion.button
                key={ch.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                onClick={() => { setSelectedChapter(ch.id); setLessonIndex(0); }}
                className="w-full text-left glass-card p-5 flex items-center gap-4"
              >
                <div className="text-3xl">{ch.title.split(" ")[0]}</div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-bold text-text-primary">{ch.title}</h2>
                    {isDone && <span className="text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded-full">완료!</span>}
                  </div>
                  <p className="text-sm text-text-tertiary mt-0.5">{ch.subtitle}</p>
                  <p className="text-xs text-text-tertiary mt-1">{ch.lessons.length}개 레슨</p>
                </div>
                <ChevronRight size={20} className="text-text-tertiary" />
              </motion.button>
            );
          })}

          {/* Badge */}
          {completed.size === CHAPTERS.length && (
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="text-center py-8"
            >
              <div className="text-5xl mb-3">🎓</div>
              <h2 className="text-lg font-bold text-text-primary">야구학도 뱃지 획득!</h2>
              <p className="text-sm text-text-tertiary mt-1">이제 야구를 즐길 준비가 됐어요!</p>
            </motion.div>
          )}
        </div>
      )}

      {/* Lesson card */}
      {chapter && (
        <div className="px-5">
          {/* Progress */}
          <div className="flex items-center gap-2 mb-4">
            {chapter.lessons.map((_, i) => (
              <div
                key={i}
                className={`h-1 flex-1 rounded-full transition-colors ${
                  i <= lessonIndex ? "bg-accent" : "bg-bg-tertiary"
                }`}
              />
            ))}
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={lessonIndex}
              initial={{ opacity: 0, x: 30 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -30 }}
              transition={{ duration: 0.2 }}
              className="glass-card p-5"
            >
              <div className="text-4xl mb-3">{chapter.lessons[lessonIndex].emoji}</div>
              <h2 className="text-lg font-bold text-text-primary mb-3">
                {chapter.lessons[lessonIndex].title}
              </h2>
              <p className="readable-body whitespace-pre-line mb-4">
                {chapter.lessons[lessonIndex].content.split(/(https?:\/\/[^\s]+)/g).map((part, i) =>
                  part.match(/^https?:\/\//) ? (
                    <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="text-accent underline break-all">
                      {part.includes("youtube") ? "🎬 영상 보기" : part}
                    </a>
                  ) : part
                )}
              </p>
              <div className="bg-bg-tertiary rounded-xl p-3">
                <p className="text-sm text-center text-text-tertiary whitespace-pre-line font-mono">
                  {chapter.lessons[lessonIndex].illustration}
                </p>
              </div>
            </motion.div>
          </AnimatePresence>

          {/* Navigation */}
          <div className="flex gap-3 mt-4">
            {lessonIndex > 0 && (
              <button
                onClick={() => setLessonIndex(i => i - 1)}
                className="flex-1 py-3 rounded-xl bg-bg-tertiary text-text-secondary font-semibold flex items-center justify-center gap-1"
              >
                <ChevronLeft size={18} /> 이전
              </button>
            )}
            {lessonIndex < chapter.lessons.length - 1 ? (
              <button
                onClick={() => setLessonIndex(i => i + 1)}
                className="flex-1 py-3 rounded-xl bg-accent text-white font-semibold flex items-center justify-center gap-1"
              >
                다음 <ChevronRight size={18} />
              </button>
            ) : (
              <button
                onClick={handleComplete}
                className="flex-1 py-3 rounded-xl bg-green-600 text-white font-semibold flex items-center justify-center gap-1"
              >
                <Check size={18} /> 완료!
              </button>
            )}
          </div>

          <p className="text-center text-xs text-text-tertiary mt-3">
            {lessonIndex + 1} / {chapter.lessons.length}
          </p>
        </div>
      )}
    </div>
  );
}
