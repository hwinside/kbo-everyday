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
