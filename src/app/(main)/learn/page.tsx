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
      { emoji: "🍗", title: "구장 먹거리", content: "야구장은 먹거리 천국!\n\n🍺 맥주: 직관의 필수템\n🍗 치킨: 매점에서 바로 구매\n🌭 핫도그: 간편 간식\n🍕 피자: 테이블석이면 배달도!\n\n💡 구장 밖 먹자골목도 꼭 가보세요!\n→ 크보 에브리데이 구장 가이드 참고 😉", illustration: "🍺 + 🍗 + ⚾ = 행복 🎉" },
      { emoji: "📱", title: "직관 꿀팁", content: "✅ 우천 시 비닐 판초 준비\n✅ 방석 가져가면 엉덩이 편함\n✅ 보조배터리 필수 (폰 많이 씀)\n✅ 자외선 차단제 (주간경기)\n✅ 경기 1시간 전 도착 (연습 구경)\n✅ 크보 에브리데이 앱 켜놓기! 😎\n\n❌ 레이저포인터, 호루라기 금지!", illustration: "준비물 체크리스트 ✅✅✅" },
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
      { emoji: "🧮", title: "실전 활용법", content: "이 지표들을 어디서 확인하나요?\n\n✅ 크보 에브리데이 선수 스탯 (네이버보다 상세!)\n✅ 스탯티즈(Statiz) — KBO 세이버 전문\n\n활용 예시:\n\n\"타율은 높은데 왜 평가가 낮지?\"\n→ BABIP 확인 (운인지 실력인지)\n\n\"ERA가 낮으면 무조건 좋은 투수?\"\n→ FIP 비교 (수비 도움 빼면?)\n\n\"MVP는 누구?\"\n→ WAR 순위 확인!", illustration: "세이버 3대장:\n타자 = wRC+\n투수 = FIP\n종합 = WAR" },
    ],
  },
  {
    id: "kbo",
    title: "🏆 KBO편",
    subtitle: "10개 구단의 역사와 2026 시즌 전력",
    lessons: [
      { emoji: "🦁", title: "삼성 라이온즈", content: "창단: 1982년 (KBO 원년)\n연고지: 대구\n우승: 8회 (KBO 최다!)\n\n💫 역대 레전드: 이승엽, 양준혁, 이병규\n\n2026 전력분석:\n• 주전급 내야 라인업 탄탄\n• 구자욱 건재 + 외국인 타자 기대\n• 투수진 재건이 과제\n• 오재일, 김지찬 등 기대주 활약 관건\n\n팬 별명: 삼팬, 라팬\n응원 특징: 조직적이고 체계적인 응원", illustration: "🏟️ 대구삼성라이온즈파크\n🏆 x8 최다우승 명가" },
      { emoji: "🐻", title: "두산 베어스", content: "창단: 1982년 (원년 OB 베어스)\n연고지: 서울 잠실\n우승: 6회\n\n💫 역대 레전드: 김동주, 김현수\n\n2026 전력분석:\n• 김하성 KBO 복귀! 내야 핵심\n• 양의지 포수 + 리더십\n• 젊은 투수진 성장세\n• 두산의 전통 가을야구 DNA\n\n팬 별명: 두팬, 곰팬\n응원 특징: 잠실 3루 열정적인 응원", illustration: "🏟️ 잠실야구장 (3루)\n🐻 가을의 팀" },
      { emoji: "🦅", title: "한화 이글스", content: "창단: 1986년 (빙그레 이글스)\n연고지: 대전\n우승: 1회 (1999년)\n\n💫 역대 레전드: 장종훈, 류현진, 김태균\n\n2026 전력분석:\n• 문동주 에이스 등극 기대\n• 노시환 장타력 건재\n• FA 보강으로 전력 상승\n• 팬들의 염원: 포스트시즌 진출!\n\n팬 별명: 한팬, 독수리\n응원 특징: 고난 속에도 꺾이지 않는 마음 💪", illustration: "🏟️ 한화생명이글스파크\n🧡 꺾이지 않는 마음" },
      { emoji: "🐯", title: "KIA 타이거즈", content: "창단: 1982년 (해태 타이거즈)\n연고지: 광주\n우승: 11회 (통합 최다!)\n\n💫 역대 레전드: 선동열, 이종범\n\n2026 전력분석:\n• 김도영 슈퍼스타 성장\n• 양현종 베테랑 리더십\n• 안우진 에이스 투수\n• 최형우 마지막 불꽃?\n• 2024 통합우승 멤버 대부분 잔류\n\n팬 별명: 기아팬, 타이거즈\n응원 특징: 광주의 뜨거운 함성", illustration: "🏟️ 광주-기아 챔피언스필드\n🏆 x11 역대 최다 우승" },
      { emoji: "⚡", title: "LG 트윈스", content: "창단: 1982년 (MBC 청룡)\n연고지: 서울 잠실\n우승: 3회 (2023 한국시리즈 29년만!)\n\n💫 역대 레전드: 박용택, 이병규\n\n2026 전력분석:\n• 오스틴 핵심 외국인 타자\n• 박동원 포수 안정감\n• 임찬규 좌완 에이스\n• 고우석 마무리 철벽\n• 엔젤 피쳐 꿈의 선발 로테이션\n\n팬 별명: 엘팬\n응원 특징: 잠실 1루 불꽃 응원 🔥", illustration: "🏟️ 잠실야구장 (1루)\n⚡ 29년의 기다림 끝에 우승!" },
      { emoji: "🦈", title: "롯데 자이언츠", content: "창단: 1982년\n연고지: 부산\n우승: 2회 (1984, 1992)\n\n💫 역대 레전드: 최동원, 가르시아\n\n2026 전력분석:\n• 전준우 베테랑 + 젊은 외야진\n• 한석현 성장 기대\n• 투수진 보강이 최대 과제\n• 사직구장의 뜨거운 응원은 변함없음\n\n팬 별명: 롯팬, 갈매기\n응원 특징: 부산 사나이들의 열정! 🎶 부산 갈매기", illustration: "🏟️ 사직야구장\n🕊️ 부산 갈매기~ 🎵" },
      { emoji: "🦅", title: "키움 히어로즈", content: "창단: 2008년 (히어로즈)\n연고지: 서울 고척\n우승: 0회 (한국시리즈 준우승 2회)\n\n💫 역대 레전드: 박병호, 이정후\n\n2026 전력분석:\n• 이정후 메이저리그 복귀 후 재적응\n• 젊은 투수 이의리 성장\n• 공격력은 상위권\n• 고척돔 홈 어드밴티지 활용\n\n팬 별명: 키팬\n응원 특징: 실내구장 특유의 웅장한 울림", illustration: "🏟️ 고척스카이돔\n🏠 국내 유일 돔구장" },
      { emoji: "🐉", title: "NC 다이노스", content: "창단: 2013년 (10번째 구단)\n연고지: 창원\n우승: 1회 (2020)\n\n💫 역대 레전드: 나성범, 박민우\n\n2026 전력분석:\n• 나성범 중심 타선\n• 소형준 좌완 에이스\n• 신인 유망주 풍부\n• 스마트한 데이터 야구 추구\n\n팬 별명: 엔팬, 다이노스\n응원 특징: 젊고 세련된 팬 문화", illustration: "🏟️ 창원NC파크\n🦕 가장 젊은 전통" },
      { emoji: "🔴", title: "SSG 랜더스", content: "창단: 2000년 (SK 와이번스 → 2021 SSG)\n연고지: 인천\n우승: 5회 (SK 시절 포함)\n\n💫 역대 레전드: 박재홍, 김광현, 최정\n\n2026 전력분석:\n• 최정 통산 홈런 기록 도전 중\n• 페르난데스 외국인 에이스\n• 두터운 선수층\n• 인천 SSG랜더스필드 최고 시설\n\n팬 별명: 에스팬, 랜더스\n응원 특징: 신생 구단의 활기찬 에너지", illustration: "🏟️ 인천SSG랜더스필드\n⚾ 최고 시설의 구장" },
      { emoji: "🔵", title: "KT 위즈", content: "창단: 2015년 (KBO 10구단 체제)\n연고지: 수원\n우승: 1회 (2021)\n\n💫 역대 레전드: 황재균, 강백호\n\n2026 전력분석:\n• 강백호 핵심 타자\n• 쿠에바스 외국인 투수 기대\n• 젊은 선수 육성에 집중\n• 수원 팬들의 열정적 지지\n\n팬 별명: 케팬, 위즈\n응원 특징: IT기업다운 스마트한 팬 경험", illustration: "🏟️ 수원KT위즈파크\n🧙 2021 첫 우승의 감동" },
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
              <p className="text-sm text-text-secondary whitespace-pre-line leading-relaxed mb-4">
                {chapter.lessons[lessonIndex].content}
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
