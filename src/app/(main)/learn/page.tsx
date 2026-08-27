"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, ChevronRight, ChevronLeft, Trophy, Check } from "lucide-react";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";

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
      { emoji: "📈", title: "핵심 기록 3가지", content: "타율: 안타 ÷ 타수 (3할이면 엘리트!)\n→ .300 = 10번 중 3번 안타\n\nERA(평균자책점): 투수가 9이닝당 내주는 점수\n→ 3.00 이하면 에이스급!\n\nOPS: 출루율 + 장타율\n→ .800 이상이면 좋은 타자!", illustration: "타율 .300 = 🌟\nERA 3.00 = 🌟\nOPS .800 = 🌟" },
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
      { emoji: "📐", title: "세이버메트릭스란?", content: "전통 기록(타율, ERA)만으로는 선수의 진짜 실력을 알기 어려워요.\n\n세이버메트릭스(SABRmetrics)는 야구를 통계학으로 분석하는 학문이에요.\n\n영화 \<머니볼\>에서 유명해진 그것! 🎬\n\n핵심 철학: \"눈에 보이는 것보다 숫자가 진실에 가깝다\"", illustration: "전통: 타율 .300 = 좋은 타자?\n세이버: 진짜 기여도는 다를 수 있다!" },
      { emoji: "🎯", title: "OPS (출루율+장타율)", content: "OPS = OBP(출루율) + SLG(장타율)\n\n출루율(OBP): 타석에서 얼마나 자주 출루하나\n→ 안타 + 볼넷 + 몸맞공 포함\n\n장타율(SLG): 안타의 질이 얼마나 좋은가\n→ 2루타=2, 홈런=4로 계산\n\n🏆 OPS 기준:\n.900+ = MVP급 🌟\n.800+ = 올스타급\n.700+ = 평균 이상\n.600 이하 = 부진", illustration: "OBP .380 + SLG .520\n= OPS .900 🌟" },
      { emoji: "📊", title: "wRC+ (가중 득점 생산력)", content: "wRC+는 타자의 종합 공격력을 하나의 숫자로!\n\n100 = 리그 평균\n150 = 평균보다 50% 더 잘 침\n70 = 평균보다 30% 못 침\n\n구장, 리그 환경까지 보정해서\n가장 공정한 타자 비교 지표예요.\n\n\"이 선수가 진짜 얼마나 잘 치나?\"의 답!", illustration: "wRC+ 150 = 엘리트 🏆\nwRC+ 100 = 평균\nwRC+ 70 = 부진 📉" },
      { emoji: "🔥", title: "WHIP (이닝당 출루 허용)", content: "WHIP = (볼넷 + 피안타) ÷ 이닝 수\n\n투수가 이닝당 얼마나 주자를 내보내는가?\n\n🏆 WHIP 기준:\n1.00 이하 = 에이스급 🌟\n1.00~1.20 = 우수\n1.20~1.40 = 평균\n1.40+ = 부진\n\nERA는 운에 영향을 많이 받지만,\nWHIP는 투수의 실제 제구력을 보여줘요.", illustration: "(안타 100 + 볼넷 30) ÷ 이닝 180\n= WHIP 0.72 🌟" },
      { emoji: "⚡", title: "FIP (수비 무관 평균자책)", content: "FIP = 투수 본인 실력만 측정!\n\n삼진, 볼넷, 홈런만으로 계산\n→ 수비수가 못 잡은 안타는 빼줌\n\nERA와 FIP 차이가 크면?\n→ ERA < FIP: 운이 좋았음 (수비 도움)\n→ ERA > FIP: 운이 나빴음 (실력은 좋음)\n\n\"진짜 잘 던지는 투수\"를 찾는 핵심 지표!", illustration: "ERA 2.50 / FIP 3.80\n= 운이 좋았던 시즌 🍀\n\nERA 4.00 / FIP 3.00\n= 실력은 좋은데 불운 😤" },
      { emoji: "🏃", title: "WAR (대체 선수 대비 승리 기여)", content: "WAR = 이 선수가 없으면 팀이 몇 승을 덜 할까?\n\n야구 세이버메트릭스의 최종 보스!\n공격 + 수비 + 주루 + 투구를 모두 합산\n\n🏆 시즌 WAR 기준:\n8+ = MVP 🏆\n5+ = 올스타 ⭐\n2+ = 주전급\n0~2 = 백업\n마이너스 = 차라리 안 쓰는 게...\n\nMVP 투표는 거의 WAR 순위와 일치!", illustration: "WAR 8.5 = 시즌 MVP 🏆\n\"이 선수 혼자 8.5승의 가치\"" },
      { emoji: "🎲", title: "BABIP (인플레이 타구 안타율)", content: "BABIP = 타구가 페어 지역에 갔을 때 안타가 될 확률\n\n리그 평균은 항상 약 .300\n\n타자 BABIP .380 → 운이 좋았을 수 있음\n타자 BABIP .230 → 운이 나빴을 수 있음\n\n\"이 타자/투수의 성적이 진짜인가?\"\n→ BABIP이 극단적이면 조만간 평균으로 돌아올 확률 높음!\n(회귀의 법칙)", illustration: "BABIP .380 → 📈 곧 하락할 수도\nBABIP .220 → 📉 곧 반등할 수도\n평균 = .300 (마법의 숫자)" },
      { emoji: "🧮", title: "실전 활용법", content: "이 지표들을 어디서 확인하나요?\n\n✅ 크보팬 선수 기록 (네이버보다 상세!)\n✅ 스탯티즈(Statiz) — KBO 세이버 전문\n\n활용 예시:\n\n\"타율은 높은데 왜 평가가 낮지?\"\n→ BABIP 확인 (운인지 실력인지)\n\n\"ERA가 낮으면 무조건 좋은 투수?\"\n→ FIP 비교 (수비 도움 빼면?)\n\n\"MVP는 누구?\"\n→ WAR 순위 확인!", illustration: "세이버 3대장:\n타자 = wRC+\n투수 = FIP\n종합 = WAR" },
    ],
  },
  {
    id: "kbo",
    title: "🏆 KBO편",
    subtitle: "10개 구단의 역사와 관전 포인트",
    lessons: [
      { emoji: "🦁", title: "삼성 라이온즈", content: "창단: 1982년 (KBO 원년 멤버)\n연고지: 대구 | 구장: 대구삼성라이온즈파크 (2016~)\n우승: 8회 (1985, 2002, 2005, 2006, 2011, 2012, 2013, 2014)\n\n📜 한 줄:\n1982년 KBO 원년 멤버. 2000년대 황금기와 2011~2014년 KBO 최초 통합 4연패로 자리 잡은 명문 구단.\n\n🌟 레전드:\n• 이승엽 — 1999년 단일시즌 54홈런 등 아시아를 대표한 거포. 일본 진출을 거쳐 KBO로 복귀.\n• 양준혁 — \"미스터 삼성\". 통산 안타·타점·홈런 모두 KBO 상위권의 좌타 거포.\n• 박한이 — 삼성 한 팀에서만 활약한 외야수. 2000년대 우승 시리즈 핵심 멤버.\n• 진갑용 — 황금기를 지킨 베테랑 포수.\n\n📊 관전 포인트:\n• 구자욱이 타선의 중심. 꾸준한 .300대 타격\n• 김영웅, 김지찬 등 젊은 야수 성장세\n• 최형우 — FA 복귀한 베테랑 클린업의 무게감\n• 마운드 깊이와 외국인 선발의 활약이 시즌 변수\n• 4연패 왕조 이후 이어지는 가을 DNA가 다시 살아날지가 관전 포인트\n\n🎵 응원 분위기:\n대구 라이온즈파크의 파란 물결 — 클래식한 KBO 응원 문화.\n📺 https://www.youtube.com/results?search_query=삼성+라이온즈+응원가", illustration: "🏟️ 대구삼성라이온즈파크\n🏆🏆🏆🏆🏆🏆🏆🏆\n통합 4연패(2011-2014)" },
      { emoji: "🐻", title: "두산 베어스", content: "창단: 1982년 (OB 베어스 → 1999 두산)\n연고지: 서울 잠실 (3루) | 구장: 잠실야구장\n우승: 6회 (1982, 1995, 2001, 2015, 2016, 2019)\n\n📜 한 줄:\n1982년 OB 베어스로 KBO 원년 초대 챔피언. 1999년 두산 베어스로 명칭 변경, 2015~2019년 사이 3번 우승하며 \"가을의 팀\" 정체성을 굳혔다.\n\n🌟 레전드:\n• 박철순 — OB 시절 에이스. 1982년 원년 우승의 주역.\n• 김동주 — \"미스터 두산\". 두산을 대표한 4번타자.\n• 김현수 — 출루율로 유명한 좌타자. MLB 볼티모어에서도 활약 후 KBO 복귀.\n• 김재환 — 2010년대 후반 두산 황금기의 거포 외야수.\n\n📊 관전 포인트:\n• 양의지 베테랑 포수의 리드. 타선의 정신적 지주\n• 곽빈, 김택연 등 젊은 투수진 성장세\n• 잠실 홈을 LG와 공유하는 \"잠실 더비\"의 한 축\n• 정규시즌 순위와 무관하게 살아나는 가을 DNA가 두산의 정체성\n\n🎵 응원 분위기:\n잠실 3루의 빨간 응원석. 가을야구 단골답게 KS 시즌의 분위기가 압도적이다.\n📺 https://www.youtube.com/results?search_query=두산+베어스+응원가", illustration: "🏟️ 잠실야구장 (3루)\n🏆 초대 챔피언 + 가을의 팀\n🐻 곰은 가을에 깨어난다" },
      { emoji: "🦅", title: "한화 이글스", content: "창단: 1986년 (빙그레 이글스 → 1994 한화)\n연고지: 대전 | 구장: 대전 한화생명 볼파크\n우승: 1회 (1999)\n\n📜 한 줄:\n1986년 빙그레 이글스로 출발해 1994년 한화 인수. 1999년 유일한 한국시리즈 우승 이후 오랜 가뭄 속에서도 \"꺾이지 않는 마음\" 슬로건의 충성 팬덤이 유명하다.\n\n🌟 레전드:\n• 장종훈 — 한화의 전설적 거포. 1999년 우승 시절 핵심 타자.\n• 송진우 — 1999년 우승을 함께한 베테랑 좌완.\n• 류현진 — 2006년 KBO 신인왕·다승왕 출신 좌완 에이스. MLB 다저스 시절 2019 사이영상 2위. 2024년 한화로 KBO 복귀.\n• 김태균 — \"대전의 아들\". 한화 프랜차이즈 거포. 일본 치바롯데에서도 활약.\n• 정우람 — KBO 통산 세이브 상위권의 마무리.\n\n📊 관전 포인트:\n• 문동주 — 차세대 에이스. 150km+ 강속구\n• 노시환 — 토종 거포 3루수의 장타력\n• 류현진 KBO 복귀(2024) 후 마운드의 무게감\n• 김서현·황준서 등 영건 투수진의 성장 추이\n• 팬들의 \"꺾이지 않는 마음\"이 만드는 홈 분위기\n\n🎵 응원 분위기:\n대전 한화생명 볼파크의 주황 물결. 만년 팬덤의 자긍심을 보여주는 응원이 인상적.\n📺 https://www.youtube.com/results?search_query=한화+이글스+응원가", illustration: "🏟️ 대전 한화생명 볼파크\n🏆 x1 (1999... 돌아와요 우승)\n🧡 꺾이지 않는 마음 💪" },
      { emoji: "🐯", title: "KIA 타이거즈", content: "창단: 1982년 (해태 타이거즈 → 2001 KIA)\n연고지: 광주 | 구장: 광주-기아 챔피언스 필드 (2014~)\n우승: 12회 (해태 9 + KIA 3) — 통합 최다!\n\n📜 한 줄:\n1982년 해태 타이거즈로 출발해 1986~1989년 4연패 포함 80~90년대 KBO 최다 우승 왕조를 구축. 2001년 KIA 인수 후 2009·2017·2024년 우승. 통산 12회 우승의 명문.\n\n🌟 레전드:\n• 선동열 — KBO를 대표한 해태/KIA 레전드 투수. 일본(주니치) 진출 경험까지.\n• 이종범 — \"바람의 아들\". 1994년 타율 .393, 196안타로 단일시즌 신화. 일본 주니치를 거쳐 KIA 복귀.\n• 양현종 — KIA 프랜차이즈 좌완. KBO 통산 다승 상위권의 리빙 레전드.\n\n📊 관전 포인트:\n• 김도영 — 2024년 30-30(30홈런·30도루) 달성한 슈퍼스타\n• 양현종 — KIA를 대표하는 좌완 베테랑\n• 2024 통합 우승 멤버 + 광주의 응원 열기가 만드는 홈 분위기\n• 통산 12회 우승의 명문, 가을야구의 단골손님\n\n🎵 응원 분위기:\n광주 챔피언스필드의 호랑이 함성 — \"호남의 성지\"로 불리는 광주의 야구 열기.\n📺 https://www.youtube.com/results?search_query=KIA+타이거즈+응원가", illustration: "🏟️ 광주-기아 챔피언스필드\n🏆🏆🏆🏆🏆🏆🏆🏆🏆🏆🏆🏆\n통합 12회 = KBO 최다!" },
      { emoji: "⚡", title: "LG 트윈스", content: "창단: 1982년 (MBC 청룡 → 1990 LG 트윈스)\n연고지: 서울 잠실 (1루) | 구장: 잠실야구장\n우승: 4회 (1990, 1994, 2023, 2025)\n\n📜 한 줄:\n1982년 MBC 청룡으로 시작, 1990년 LG 인수와 동시에 첫 우승. 1994년 두 번째 우승 후 29년의 가뭄을 거쳐 2023년 다시 한국시리즈 정상에 올랐고, 2025년 또 한 번 우승하며 통산 4회를 채웠다.\n\n🌟 레전드:\n• 박용택 — \"잠실의 황태자\". KBO 통산 안타 1위(2,504안타). LG 한 팀의 원클럽맨.\n• 이병규 — LG의 간판 외야수. 일본 주니치(2007~2009)를 거쳐 LG로 복귀한 좌타자.\n• 이상훈 — LG 시절 좌완 에이스. 일본 진출도 경험.\n• 봉중근 — LG의 좌완. 선발에서 마무리로 전환한 베테랑.\n\n📊 관전 포인트:\n• 오스틴 — 핵심 4번타자. 장타력+선구안 모두 상급\n• 임찬규·손주영 등 토종 선발진\n• 박동원 — 안정적인 안방마님\n• 고우석 MLB 진출(2024) 이후 마무리 자리의 새 얼굴 찾기가 변수\n• 2023년 29년 만의 우승 이후 이어가는 잠실 1루의 자신감\n\n🎵 응원 분위기:\n잠실 1루의 화려한 응원과 치어리더. 2023년 우승 이후 자부심이 한층 더해진 분위기.\n📺 https://www.youtube.com/results?search_query=LG+트윈스+응원가", illustration: "🏟️ 잠실야구장 (1루)\n🏆🏆🏆🏆\n29년의 기다림, 2023 그리고 2025! ⚡" },
      { emoji: "🕊️", title: "롯데 자이언츠", content: "창단: 1982년 (KBO 원년)\n연고지: 부산 | 구장: 사직야구장\n우승: 2회 (1984, 1992)\n\n📜 한 줄:\n1982년 KBO 원년 멤버. 1984년·1992년 한국시리즈 우승 이후 오랜 가뭄에도 사직야구장의 \"부산 갈매기\" 떼창으로 대표되는 KBO 최상급 팬덤을 자랑한다.\n\n🌟 레전드:\n• 최동원 — \"부산의 아들\". 1984년 한국시리즈에서 다회 등판으로 우승을 이끈 전설의 우완. 영구결번 #11.\n• 박정태 — 롯데 프랜차이즈 2루수. 1992년 한국시리즈 우승의 주역.\n• 이대호 — 롯데의 간판 4번타자. 일본(오릭스·소프트뱅크)·MLB 시애틀을 거쳐 롯데로 복귀해 은퇴.\n• 전준우 — 롯데 한 팀에서 오래 활약한 베테랑 외야수.\n\n📊 관전 포인트:\n• 전준우 — 베테랑 외야수의 통산 기록 행보\n• 차세대 야수진의 성장 (윤동희·황성빈 등)\n• 매 시즌 거론되는 토종 선발진 안정화 과제\n• 사직 응원 분위기는 \"12번째 선수\" 소리를 듣는 KBO 톱급\n• \"올해는 되겠지\" — 부산의 영원한 희망\n\n🎵 응원 분위기:\n사직야구장의 \"부산 갈매기\" 떼창 — KBO 응원 문화의 상징적 장면.\n📺 https://www.youtube.com/results?search_query=롯데+자이언츠+부산갈매기", illustration: "🏟️ 사직야구장\n🏆🏆 (1984, 1992)\n🎵 부~산 갈매기~ 🕊️" },
      { emoji: "🦸", title: "키움 히어로즈", content: "창단: 2008년 (서울 히어로즈 → 넥센 → 키움)\n연고지: 서울 구로 | 구장: 고척스카이돔\n우승: 0회 (한국시리즈 준우승 2014, 2019, 2022)\n\n📜 한 줄:\n현대 유니콘스 해체 후 선수단을 인수해 2008년 창단. 모기업 없이 메인 스폰서(넥센→키움)에 의존하는 구조에서도 2014·2019·2022년 한국시리즈 진출로 경쟁력을 이어온 모기업 없는 스폰서십 기반 구단.\n\n🌟 레전드:\n• 박병호 — 키움/넥센 시절 KBO를 대표한 거포. MLB 미네소타에서도 활약.\n• 이정후 — 2022 KBO 정규시즌 MVP·타격왕 출신 외야수. 2024년 SF 자이언츠로 진출.\n• 서건창 — 2014시즌 KBO 단일시즌 최다 안타(201) 기록을 남긴 컨택형 내야수.\n• 김혜성 — 키움 자체 육성 내야수. 2025시즌 LA 다저스로 MLB 진출.\n\n📊 관전 포인트:\n• 이정후(SF), 김혜성(LAD) 등 잇따른 MLB 진출 — \"메이저리그 사관학교\" 노선\n• 영건 투수진의 마운드 안착 여부가 매 시즌 화두\n• 모기업 없는 스폰서십 기반 구단 → 육성 시스템에 의존하는 구단 컬러\n• 고척돔 — KBO 유일 돔구장. 우천 영향 없는 일정 강점\n• 한국시리즈 우승 0회의 설움을 푸는 해가 될까?\n\n🎵 응원 분위기:\n고척돔 특유의 울림이 만드는 응원 사운드. 비 걱정 없이 즐길 수 있는 KBO 유일 돔구장 직관 환경.\n📺 https://www.youtube.com/results?search_query=키움+히어로즈+응원가", illustration: "🏟️ 고척스카이돔\n🥈 준우승 3번 (2014·2019·2022)\n🦸 모기업 없는 스폰서십 기반 구단의 기적" },
      { emoji: "🦕", title: "NC 다이노스", content: "창단: 2011년 / 1군 데뷔: 2013년 (KBO 9번째 구단)\n연고지: 창원 | 구장: 창원NC파크 (2019~)\n우승: 1회 (2020)\n\n📜 한 줄:\n2011년 NC소프트(김택진 대표)가 창단해 2013년 1군에 진입한 KBO 9번째 구단. 2020년 한국시리즈 첫 우승을 차지한 데이터 야구 컬러의 신생 명문.\n\n🌟 레전드:\n• 양의지 — 2019년 FA로 NC 합류, 2020 한국시리즈 MVP. 이후 두산으로 복귀한 KBO 대표 포수.\n• 나성범 — NC 시절 간판 외야수. 강한 어깨와 장타력. 2022시즌부터는 KIA 소속.\n• 박민우 — 컨택+수비를 겸비한 내야수. 골든글러브 다수.\n• 에릭 테임즈 — NC 초창기 외국인 거포. KBO에서 강렬한 활약 후 MLB 밀워키 진출.\n• 구창모 — NC 자체 육성 좌완의 상징.\n\n📊 관전 포인트:\n• 박민우 — 수비+컨택의 균형 잡힌 내야수\n• 손아섭·박건우 — FA로 NC에 합류한 베테랑 외야진\n• 데이터 기반 운영 — NC소프트 DNA가 묻은 \"머니볼\" 스타일\n• 2020 창단 첫 우승 이후 자리 잡은 단단한 선수층\n• 창원NC파크 — 2019 개장한 KBO 최신 구장 중 하나\n\n🎵 응원 분위기:\n2019년 개장한 창원NC파크의 모던한 직관 환경. 짧은 역사답게 젊은 팬층의 분위기가 두드러진다.\n📺 https://www.youtube.com/results?search_query=NC+다이노스+응원가", illustration: "🏟️ 창원NC파크\n🏆 2020 한국시리즈 첫 우승\n🦕 IT + 야구 = 데이터 다이노스" },
      { emoji: "🔴", title: "SSG 랜더스", content: "창단: 2000년 (SK 와이번스 → 2021 SSG)\n연고지: 인천 | 구장: 인천SSG랜더스필드 (옛 문학구장의 리브랜딩)\n우승: 5회 (2007, 2008, 2010, 2018, 2022) — SK 시절 포함\n\n📜 한 줄:\n2000년 SK 와이번스로 창단해 2007·2008·2010·2018년 우승의 \"인천 왕조\"를 만든 팀. 2021년 신세계 인수와 함께 SSG 랜더스로 리브랜딩, 2022년 새 이름 첫 해에 우승했다.\n\n🌟 레전드:\n• 박재홍 — 1996년 KBO 신인왕 출신 외야수. 30-30 클럽 가입 후 SK에서 중심 타자로 활약.\n• 김광현 — KBO 좌완의 상징. MLB 세인트루이스를 거쳐 2022년 SSG로 복귀.\n• 최정 — KBO 통산 홈런 1위의 살아있는 전설. SK·SSG 한 팀에서만 오래 활약.\n• 김강민 — 2022 한국시리즈 MVP. 베테랑 외야수의 대역전 만루홈런 신화.\n\n📊 관전 포인트:\n• 최정 — KBO 통산 홈런 1위, 살아있는 전설의 기록 행보\n• 김광현 — SSG 복귀(2022) 후 자리 잡은 좌완의 무게감\n• 박성한 등 자체 육성 야수의 성장세\n• 신세계 자본의 투자 의지가 만든 두터운 선수층\n• 랜더스필드 — 리모델링으로 KBO 최상급 시설을 갖춘 구장\n\n🎵 응원 분위기:\n랜더스필드 리모델링으로 KBO 최상급 시설을 갖춘 직관 환경. 신세계 자본 투자의 컬러가 묻어난다.\n📺 https://www.youtube.com/results?search_query=SSG+랜더스+응원가", illustration: "🏟️ 인천SSG랜더스필드\n🏆🏆🏆🏆🏆\n최정 = 🇰🇷 홈런왕 레전드" },
      { emoji: "🧙", title: "KT 위즈", content: "창단: 2015년 (KBO 10번째 구단, 현 10구단 체제 완성)\n연고지: 수원 | 구장: 수원KT위즈파크\n우승: 1회 (2021)\n\n📜 한 줄:\n2015년 KT가 창단한 KBO 10번째(막내) 구단. 초창기 최하위를 전전하다가 2021년 한국시리즈 우승으로 \"꼴찌에서 챔피언\" 드라마를 완성했다.\n\n🌟 레전드:\n• 강백호 — 2018 KBO 신인왕 출신 거포. 2021년 우승 멤버.\n• 박경수 — 2021 한국시리즈 MVP. 우승 시즌의 베테랑 2루수.\n• 황재균 — MLB 샌프란시스코를 거쳐 2018년 KT 합류. 2017 WBC 국가대표.\n• 쿠에바스 — KT의 외국인 우완 에이스로 다수 시즌 활약.\n• 멜 로하스 주니어 — 2020 KBO 정규시즌 MVP. 이후 일본(한신) 진출.\n\n📊 관전 포인트:\n• 외국인 투수의 활약이 매 시즌 결정적 변수\n• 2021 우승 멤버 일부 + 새로 합류한 베테랑·신예의 조화\n• 젊은 선수 육성 시스템 가동 중\n• 수원 팬 베이스 꾸준히 성장 — 위즈파크 분위기 업그레이드\n• 창단 7년 만의 \"꼴찌→챔피언\" DNA\n\n🎵 응원 분위기:\n수원KT위즈파크의 불꽃놀이 이벤트와 응원이 인기 직관 코스.\n📺 https://www.youtube.com/results?search_query=KT+위즈+응원가", illustration: "🏟️ 수원KT위즈파크\n🏆 2021 꼴찌→챔피언!\n🧙 7년 만의 마법" },
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
      <div className="sticky top-0 z-30 border-b border-border bg-bg-primary" style={{ paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
      <header className="px-5 min-h-[44px] flex items-center">
        <div className="flex w-full items-center justify-between gap-3">
          <div className="min-w-0">
            {selectedChapter ? (
              <button onClick={() => { setSelectedChapter(null); setLessonIndex(0); }} aria-label="목록으로" className="flex h-11 min-h-[44px] items-center gap-1 -ml-1 text-text-secondary">
                <ArrowLeft size={20} />
                <span className="text-sm">목록으로</span>
              </button>
            ) : (
              <h1 className="text-xl font-bold text-text-primary">⚾ 야구 쉽게 배우기</h1>
            )}
          </div>
          <HeaderProfileLink />
        </div>
      </header>
      </div>

      {/* 헤더에서 바디로 내린 서브문구 */}
      {!selectedChapter && (
        <p className="px-5 pt-3 text-sm text-text-tertiary">처음이어도 괜찮아요, 5분이면 충분!</p>
      )}

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
              <div className="bg-bg-tertiary rounded-xl p-3 border border-border">
                <p className="text-sm text-center text-text-secondary whitespace-pre-line font-mono">
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
