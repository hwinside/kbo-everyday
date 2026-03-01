"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Brain, TrendingUp, Swords, Zap } from "lucide-react";
import Image from "next/image";
import { getTeamById } from "@/lib/constants/teams";

interface AIAnalysisProps {
  isOpen: boolean;
  onClose: () => void;
  awayTeamId: number;
  homeTeamId: number;
}

// Mock AI 분석 데이터 생성
function generateAnalysis(awayId: number, homeId: number) {
  const away = getTeamById(awayId)!;
  const home = getTeamById(homeId)!;
  
  const awayWinPct = Math.floor(Math.random() * 30) + 35; // 35~65%
  const homeWinPct = 100 - awayWinPct;
  const confidence = Math.floor(Math.random() * 20) + 65; // 65~85%

  return {
    away: {
      team: away,
      winPct: awayWinPct,
      strengths: ["최근 5경기 4승 1패", "선발투수 ERA 2.89", "득점권 타율 .312"],
      weaknesses: ["불펜 피로도 누적", "좌투수 상대 타율 부진"],
    },
    home: {
      team: home,
      winPct: homeWinPct,
      strengths: ["홈 경기 승률 .621", "클린업 트리오 OPS .890+", "최근 10경기 7승"],
      weaknesses: ["선발투수 이닝 소화 불안", "도루 허용률 높음"],
    },
    keyMatchup: `${away.shortName} 선발 vs ${home.shortName} 클린업 대결이 승부의 핵심. ${homeWinPct > 50 ? home.shortName : away.shortName}의 홈/원정 이점과 최근 폼을 고려하면 소폭 우세.`,
    prediction: homeWinPct > 50 
      ? `${home.shortName} ${homeWinPct}% 우세 예측` 
      : `${away.shortName} ${awayWinPct}% 우세 예측`,
    confidence,
  };
}

export default function AIAnalysis({ isOpen, onClose, awayTeamId, homeTeamId }: AIAnalysisProps) {
  const [analysis] = useState(() => generateAnalysis(awayTeamId, homeTeamId));

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
            className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-bg-secondary overflow-y-auto"
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
                <h2 className="text-lg font-bold text-text-primary">AI 훈수</h2>
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
                    <span className="text-base font-bold" style={{ color: analysis.away.team.colorPrimary }}>
                      {analysis.away.team.shortName}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-base font-bold" style={{ color: analysis.home.team.colorPrimary }}>
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
                      <span className="text-sm font-bold" style={{ color: side.team.colorPrimary }}>{side.team.shortName}</span>
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
                <p className="text-sm text-text-secondary leading-relaxed">{analysis.keyMatchup}</p>
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
