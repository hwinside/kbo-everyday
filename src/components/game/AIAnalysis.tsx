"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Brain, TrendingUp, Swords, Zap } from "lucide-react";
import Image from "next/image";
import { getTeamById } from "@/lib/constants/teams";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { useRouter } from "next/navigation";

interface AIAnalysisProps {
  isOpen: boolean;
  onClose: () => void;
  awayTeamId: number;
  homeTeamId: number;
}

// Mock AI 분석 데이터 생성
// 팀별 mock 선수 데이터
interface KeyPlayer {
  name: string;
  playerId: string;
  reason: string;
}

const TEAM_PLAYERS: Record<number, { sp: string; spEra: string; ace: string; cleanup: string[]; closer: string; closerSv: string; keyPlayers: KeyPlayer[] }> = {
  1: { sp: "곽빈", spEra: "2.89", ace: "임찬규", cleanup: ["오스틴", "문보경", "김현수"], closer: "고우석", closerSv: "28", keyPlayers: [{ name: "오스틴", playerId: "53123", reason: "시즌 OPS .952, 득점권 타율 .389로 클러치 상황에서 가장 위협적인 타자" }, { name: "임찬규", playerId: "67893", reason: "선발 ERA 2.45, 최근 6경기 QS 5회로 팀 최고 안정감" }] },
  2: { sp: "곽빈", spEra: "3.12", ace: "알칸타라", cleanup: ["양의지", "케이브", "장승현"], closer: "정철원", closerSv: "24", keyPlayers: [{ name: "양의지", playerId: "76232", reason: "통산 타율 .337의 베테랑 포수, 결정적 순간 경험이 빛나는 선수" }, { name: "알칸타라", playerId: "54529", reason: "시즌 12승 ERA 3.12, 이닝이터로 불펜 부담 최소화" }] },
  3: { sp: "소형준", spEra: "3.45", ace: "소형준", cleanup: ["안현민", "허경민", "강백호"], closer: "박영현", closerSv: "22", keyPlayers: [{ name: "강백호", playerId: "52001", reason: "좌타 최강 파워히터, 시즌 28홈런으로 한 방에 경기를 뒤집는 능력" }, { name: "소형준", playerId: "50662", reason: "구위 상승세, 최근 5경기 평균 7이닝 소화" }] },
  4: { sp: "김광현", spEra: "2.76", ace: "김광현", cleanup: ["최지훈", "한유섬", "고명준"], closer: "조병현", closerSv: "19", keyPlayers: [{ name: "최지훈", playerId: "50854", reason: "리드오프 출루율 .398, 득점 선두로 공격 시작점" }, { name: "김광현", playerId: "62404", reason: "빅게임 경험 풍부, 포스트시즌 ERA 2.31" }] },
  5: { sp: "로건", spEra: "3.21", ace: "로건", cleanup: ["박민우", "김주원", "데이비슨"], closer: "전사민", closerSv: "17", keyPlayers: [{ name: "박민우", playerId: "62907", reason: "출루+도루 조합으로 상대 배터리 흔드는 테이블 세터" }, { name: "로건", playerId: "51104", reason: "FA컵 최다승, 이닝이터로 중심 역할" }] },
  6: { sp: "양현종", spEra: "3.05", ace: "양현종", cleanup: ["김도영", "나성범", "최형우"], closer: "정해영", closerSv: "31", keyPlayers: [{ name: "김도영", playerId: "52605", reason: "시즌 .335/.400/.580, 20-20 달성한 올라운드 유격수" }, { name: "양현종", playerId: "75645", reason: "통산 최다승 레전드, 빅게임에서 흔들리지 않는 정신력" }] },
  7: { sp: "레이예스", spEra: "3.67", ace: "레이예스", cleanup: ["전준우", "고승민", "문현빈"], closer: "배재환", closerSv: "15", keyPlayers: [{ name: "전준우", playerId: "78513", reason: "사직 통산 타율 .321, 홈에서 유독 강한 프랜차이즈 스타" }, { name: "레이예스", playerId: "54529", reason: "3년 연속 3할, 꾸준함의 대명사" }] },
  8: { sp: "이승현", spEra: "3.33", ace: "이승현", cleanup: ["구자욱", "디아즈", "김성윤"], closer: "이호성", closerSv: "20", keyPlayers: [{ name: "구자욱", playerId: "62404", reason: "타격왕 후보, 시즌 .348로 안타 제조기" }, { name: "디아즈", playerId: "54400", reason: "50홈런 시즌 기록 보유, 리그 최강 장거리포" }] },
  9: { sp: "문동주", spEra: "2.95", ace: "문동주", cleanup: ["채은성", "노시환", "문현빈"], closer: "김서현", closerSv: "18", keyPlayers: [{ name: "문동주", playerId: "51344", reason: "차세대 에이스, ERA 2.95에 탈삼진율 리그 상위" }, { name: "노시환", playerId: "69517", reason: "40홈런 잠재력, 풀스윙 파워로 경기를 한 방에 결정" }] },
  10: { sp: "안우진", spEra: "2.68", ace: "안우진", cleanup: ["송성문", "김혜성", "최주환"], closer: "조상우", closerSv: "25", keyPlayers: [{ name: "안우진", playerId: "68341", reason: "리그 최고 구속+제구, MLB 복귀 후에도 압도적 구위" }, { name: "김혜성", playerId: "64300", reason: "출루율 .420, 1번 타자로 경기 흐름을 지배" }] },
};

function generateAnalysis(awayId: number, homeId: number) {
  const away = getTeamById(awayId)!;
  const home = getTeamById(homeId)!;
  const ap = TEAM_PLAYERS[awayId] || TEAM_PLAYERS[1];
  const hp = TEAM_PLAYERS[homeId] || TEAM_PLAYERS[1];
  
  const awayWinPct = Math.floor(Math.random() * 30) + 35;
  const homeWinPct = 100 - awayWinPct;
  const confidence = Math.floor(Math.random() * 20) + 65;

  return {
    away: {
      team: away,
      winPct: awayWinPct,
      strengths: [
        `선발 ${ap.sp} 최근 5경기 ERA ${ap.spEra}`,
        `${ap.cleanup[0]} 최근 10경기 타율 .348, ${ap.cleanup[1]} OPS .912`,
        `마무리 ${ap.closer} ${ap.closerSv}세이브, 최근 12경기 무실점`,
      ],
      weaknesses: [
        `${ap.cleanup[2]} 좌투수 상대 타율 .198로 부진`,
        `불펜 5~7이닝 피안타율 .289 취약`,
      ],
    },
    home: {
      team: home,
      winPct: homeWinPct,
      strengths: [
        `선발 ${hp.sp} 홈 ERA ${(parseFloat(hp.spEra) - 0.4).toFixed(2)}, 홈 경기 5연승`,
        `${hp.cleanup[0]} 시즌 21호 홈런, 득점권 타율 .362`,
        `${hp.cleanup[1]} 최근 15경기 연속 안타, 타율 .341`,
      ],
      weaknesses: [
        `${hp.closer} 최근 3경기 블론세이브 2회`,
        `대주자 상황 도루 허용률 78% (리그 하위)`,
      ],
    },
    keyMatchup: `🔑 이번 경기의 핵심은 ${away.shortName} ${ap.sp}(ERA ${ap.spEra}) vs ${home.shortName} 클린업 ${hp.cleanup[0]}·${hp.cleanup[1]} 대결입니다.

${ap.sp}은 최근 5경기 평균 6.2이닝을 소화하며 안정적인 투구를 이어가고 있지만, ${hp.cleanup[0]}에게 시즌 상대전적 7타수 4안타(.571)로 크게 밀리고 있습니다.

반면 ${home.shortName} ${hp.sp}은 홈에서 유독 강한 모습(홈 ERA ${(parseFloat(hp.spEra) - 0.4).toFixed(2)})을 보이고 있어 ${away.shortName} 타선이 초반에 흔들 수 있을지가 관건입니다.

${away.shortName}이 승리하려면 ${ap.cleanup[0]}의 멀티히트와 불펜의 안정이 필수이고, ${home.shortName}은 ${hp.cleanup[0]}·${hp.cleanup[1]}의 중심 타선이 선발을 일찍 무너뜨려야 합니다.`,
    prediction: homeWinPct > 50 
      ? `${home.shortName} ${homeWinPct}% 우세 (${hp.cleanup[0]}의 홈 타율 + ${hp.sp} 홈 ERA 기반)` 
      : `${away.shortName} ${awayWinPct}% 우세 (${ap.sp}의 최근 폼 + ${ap.cleanup[0]} 핫스트릭)`,
    confidence,
    awayKeyPlayers: ap.keyPlayers || [],
    homeKeyPlayers: hp.keyPlayers || [],
  };
}

export default function AIAnalysis({ isOpen, onClose, awayTeamId, homeTeamId }: AIAnalysisProps) {
  const router = useRouter();
  const [analysis] = useState(() => generateAnalysis(awayTeamId, homeTeamId));

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  }, [isOpen]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/70"
            onClick={onClose}
          />
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-bg-secondary overflow-y-auto overscroll-contain touch-pan-y max-h-[85vh]"
            style={{ maxHeight: "85vh" }}
          >
            {/* Handle */}
            <div className="flex justify-center pt-2">
              <div className="h-1 w-10 rounded-full bg-text-tertiary" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3">
              <div className="flex items-center gap-2">
                <Brain size={20} className="text-accent" />
                <h2 className="text-lg font-bold text-text-primary">AI 분석</h2>
              </div>
              <button onClick={onClose} className="text-text-secondary p-1">
                <X size={22} />
              </button>
            </div>

            <div className="px-5 pb-8 space-y-5">
              {/* Win probability bar */}
              <div className="glass-card p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full bg-white p-1 flex items-center justify-center">
                      <Image src={analysis.away.team.logoPath} alt="" width={24} height={24} unoptimized className="object-contain" />
                    </div>
                    <span className="text-base font-bold" style={{ color: analysis.away.team.colorLight }}>
                      {analysis.away.team.shortName}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-base font-bold" style={{ color: analysis.home.team.colorLight }}>
                      {analysis.home.team.shortName}
                    </span>
                    <div className="w-8 h-8 rounded-full bg-white p-1 flex items-center justify-center">
                      <Image src={analysis.home.team.logoPath} alt="" width={24} height={24} unoptimized className="object-contain" />
                    </div>
                  </div>
                </div>

                {/* Probability bar */}
                <div className="flex h-10 rounded-xl overflow-hidden">
                  <motion.div
                    initial={{ width: "50%" }}
                    animate={{ width: `${analysis.away.winPct}%` }}
                    transition={{ duration: 1, ease: "easeOut" }}
                    className="flex items-center justify-center text-white text-sm font-bold"
                    style={{ backgroundColor: analysis.away.team.colorPrimary }}
                  >
                    {analysis.away.winPct}%
                  </motion.div>
                  <motion.div
                    initial={{ width: "50%" }}
                    animate={{ width: `${analysis.home.winPct}%` }}
                    transition={{ duration: 1, ease: "easeOut" }}
                    className="flex items-center justify-center text-white text-sm font-bold"
                    style={{ backgroundColor: analysis.home.team.colorPrimary }}
                  >
                    {analysis.home.winPct}%
                  </motion.div>
                </div>
                <div className="mt-2 text-center">
                  <span className="text-xs text-text-tertiary">AI 신뢰도 {analysis.confidence}%</span>
                </div>
              </div>

              {/* Team analysis cards */}
              <div className="grid grid-cols-2 gap-3">
                {[analysis.away, analysis.home].map((side) => (
                  <div key={side.team.id} className="glass-card p-3 space-y-2">
                    <div className="flex items-center gap-1.5 mb-2">
                      <div className="w-5 h-5 rounded-full bg-white p-0.5 flex items-center justify-center">
                        <Image src={side.team.logoPath} alt="" width={14} height={14} unoptimized className="object-contain" />
                      </div>
                      <span className="text-sm font-bold" style={{ color: side.team.colorLight }}>{side.team.shortName}</span>
                    </div>
                    <div>
                      <div className="flex items-center gap-1 mb-1">
                        <TrendingUp size={12} className="text-green-400" />
                        <span className="text-xs font-semibold text-green-400">강점</span>
                      </div>
                      {side.strengths.map((s, i) => (
                        <p key={i} className="text-xs text-text-secondary ml-4">• {s}</p>
                      ))}
                    </div>
                    <div>
                      <div className="flex items-center gap-1 mb-1">
                        <Zap size={12} className="text-red-400" />
                        <span className="text-xs font-semibold text-red-400">약점</span>
                      </div>
                      {side.weaknesses.map((w, i) => (
                        <p key={i} className="text-xs text-text-secondary ml-4">• {w}</p>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {/* Key matchup */}
              <div className="glass-card p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Swords size={16} className="text-accent" />
                  <span className="text-sm font-bold text-text-primary">핵심 포인트</span>
                </div>
                <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-line">{analysis.keyMatchup}</p>
              </div>

              {/* Prediction */}
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.5 }}
                className="text-center py-3 rounded-xl"
                style={{
                  background: `linear-gradient(135deg, ${analysis.away.team.colorPrimary}20, ${analysis.home.team.colorPrimary}20)`,
                }}
              >
                <p className="text-xs text-text-tertiary mb-1">🤖 AI 예측</p>
                <p className="text-base font-bold text-text-primary">{analysis.prediction}</p>
              </motion.div>

              {/* Key Players */}
              <div className="glass-card p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-base">⭐</span>
                  <span className="text-sm font-bold text-text-primary">승부의 키플레이어</span>
                </div>

                {[
                  { label: analysis.away.team.shortName, color: analysis.away.team.colorLight, players: analysis.awayKeyPlayers, teamId: awayTeamId },
                  { label: analysis.home.team.shortName, color: analysis.home.team.colorLight, players: analysis.homeKeyPlayers, teamId: homeTeamId },
                ].map((side) => (
                  <div key={side.label} className="mb-4 last:mb-0">
                    <span className="text-xs font-bold mb-2 block" style={{ color: side.color }}>{side.label}</span>
                    <div className="space-y-2.5">
                      {side.players.map((p) => (
                        <div
                          key={p.playerId}
                          onClick={() => { onClose(); router.push(`/boards/players/${p.playerId}`); }}
                          className="flex items-start gap-3 p-2 rounded-xl hover:bg-white/5 cursor-pointer transition-colors"
                        >
                          <PlayerAvatar name={p.name} teamId={side.teamId} photoUrl={getPlayerPhotoUrl(p.name)} size={48} />
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-bold text-text-primary">{p.name}</span>
                            <p className="text-xs text-text-secondary mt-0.5 leading-relaxed">{p.reason}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <p className="text-center text-xs text-text-tertiary">
                ※ AI 분석은 참고용이며 실제 경기 결과와 다를 수 있습니다
              </p>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
