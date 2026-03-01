"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import { Users, Check, Lock } from "lucide-react";
import { getTeamById } from "@/lib/constants/teams";
import type { PredictionMock } from "@/lib/constants/predictions";
import GlassCard from "@/components/ui/GlassCard";

interface PredictionCardProps {
  prediction: PredictionMock;
}

export default function PredictionCard({ prediction: initial }: PredictionCardProps) {
  const [pred, setPred] = useState(initial);
  const [justPicked, setJustPicked] = useState(false);

  const awayTeam = getTeamById(pred.awayTeamId)!;
  const homeTeam = getTeamById(pred.homeTeamId)!;
  const isFinished = pred.status === "finished";
  const isLocked = pred.status === "locked";
  const isOpen = pred.status === "open";
  const hasPicked = pred.myPick !== null;
  const awayCorrect = isFinished && pred.winnerTeamId === pred.awayTeamId;
  const homeCorrect = isFinished && pred.winnerTeamId === pred.homeTeamId;
  const myPickCorrect = isFinished && pred.myPick === pred.winnerTeamId;

  function handlePick(teamId: number) {
    if (!isOpen || hasPicked) return;
    // 투표 시 퍼센트 살짝 변화 + 투표수 증가
    const isAway = teamId === pred.awayTeamId;
    const newTotal = pred.totalVotes + 1;
    const awayPct = isAway ? pred.awayPercent + 1 : pred.awayPercent - 1;
    const homePct = 100 - awayPct;
    
    setPred({
      ...pred,
      myPick: teamId,
      totalVotes: newTotal,
      awayPercent: Math.max(1, Math.min(99, awayPct)),
      homePercent: Math.max(1, Math.min(99, homePct)),
    });
    setJustPicked(true);
    setTimeout(() => setJustPicked(false), 2000);
  }

  return (
    <GlassCard className={`p-4 ${isFinished ? "opacity-80" : ""}`}>
      {/* Status bar */}
      <div className="flex items-center justify-between mb-3">
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
          isLocked ? "bg-yellow-500/20 text-yellow-400" :
          isFinished ? "bg-text-tertiary/20 text-text-tertiary" :
          "bg-green-500/20 text-green-400"
        }`}>
          {isLocked ? "🔒 투표 마감" : isFinished ? "종료" : "🟢 투표 가능"}
        </span>
        <div className="flex items-center gap-1 text-xs text-text-tertiary">
          <Users size={12} />
          <span className="tabular-nums">{pred.totalVotes.toLocaleString()}명</span>
          {isFinished && pred.homeScore !== null && (
            <span className="ml-2 font-bold text-text-secondary">
              {pred.awayScore} : {pred.homeScore}
            </span>
          )}
        </div>
      </div>

      {/* Team buttons */}
      <div className="flex gap-3 mb-3">
        {/* Away */}
        <button
          onClick={() => handlePick(pred.awayTeamId)}
          disabled={!isOpen || hasPicked}
          className={`flex-1 rounded-xl p-3 transition-all border-2 ${
            pred.myPick === pred.awayTeamId
              ? awayCorrect ? "border-green-500 bg-green-500/10" :
                isFinished ? "border-red-500/50 bg-red-500/5" :
                "border-current bg-white/5"
              : "border-transparent bg-bg-tertiary/50 hover:bg-bg-tertiary"
          } ${isOpen && !hasPicked ? "cursor-pointer active:scale-95" : ""}`}
          style={pred.myPick === pred.awayTeamId && !isFinished ? { borderColor: awayTeam.colorLight } : {}}
        >
          <div className="flex flex-col items-center gap-2">
            <div className="w-10 h-10 rounded-full bg-white p-1 flex items-center justify-center">
              <Image src={awayTeam.logoPath} alt="" width={28} height={28} unoptimized className="object-contain" />
            </div>
            <span className="text-sm font-bold" style={{ color: awayTeam.colorLight }}>{awayTeam.shortName}</span>
            {pred.myPick === pred.awayTeamId && (
              <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} className="flex items-center gap-1">
                <Check size={12} className={myPickCorrect || !isFinished ? "text-green-400" : "text-red-400"} />
                <span className={`text-xs font-semibold ${myPickCorrect || !isFinished ? "text-green-400" : "text-red-400"}`}>
                  {isFinished ? (myPickCorrect ? "적중!" : "아쉽!") : "내 예측"}
                </span>
              </motion.div>
            )}
          </div>
        </button>

        <div className="flex items-center text-text-tertiary text-sm font-medium">VS</div>

        {/* Home */}
        <button
          onClick={() => handlePick(pred.homeTeamId)}
          disabled={!isOpen || hasPicked}
          className={`flex-1 rounded-xl p-3 transition-all border-2 ${
            pred.myPick === pred.homeTeamId
              ? homeCorrect ? "border-green-500 bg-green-500/10" :
                isFinished ? "border-red-500/50 bg-red-500/5" :
                "border-current bg-white/5"
              : "border-transparent bg-bg-tertiary/50 hover:bg-bg-tertiary"
          } ${isOpen && !hasPicked ? "cursor-pointer active:scale-95" : ""}`}
          style={pred.myPick === pred.homeTeamId && !isFinished ? { borderColor: homeTeam.colorLight } : {}}
        >
          <div className="flex flex-col items-center gap-2">
            <div className="w-10 h-10 rounded-full bg-white p-1 flex items-center justify-center">
              <Image src={homeTeam.logoPath} alt="" width={28} height={28} unoptimized className="object-contain" />
            </div>
            <span className="text-sm font-bold" style={{ color: homeTeam.colorLight }}>{homeTeam.shortName}</span>
            {pred.myPick === pred.homeTeamId && (
              <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} className="flex items-center gap-1">
                <Check size={12} className={myPickCorrect || !isFinished ? "text-green-400" : "text-red-400"} />
                <span className={`text-xs font-semibold ${myPickCorrect || !isFinished ? "text-green-400" : "text-red-400"}`}>
                  {isFinished ? (myPickCorrect ? "적중!" : "아쉽!") : "내 예측"}
                </span>
              </motion.div>
            )}
          </div>
        </button>
      </div>

      {/* Prediction distribution bar */}
      <div>
        <div className="flex h-3 overflow-hidden rounded-full">
          <motion.div
            className="rounded-l-full"
            initial={{ width: "50%" }}
            animate={{ width: `${pred.awayPercent}%` }}
            transition={{ duration: 0.8, ease: "easeOut" }}
            style={{ backgroundColor: awayCorrect ? "#22C55E" : awayTeam.colorPrimary }}
          />
          <motion.div
            className="rounded-r-full"
            initial={{ width: "50%" }}
            animate={{ width: `${pred.homePercent}%` }}
            transition={{ duration: 0.8, ease: "easeOut", delay: 0.1 }}
            style={{ backgroundColor: homeCorrect ? "#22C55E" : homeTeam.colorPrimary }}
          />
        </div>
        <div className="mt-1.5 flex justify-between text-xs tabular-nums">
          <span className="font-bold" style={{ color: awayTeam.colorLight }}>
            {awayTeam.shortName} {pred.awayPercent}%
          </span>
          <span className="font-bold" style={{ color: homeTeam.colorLight }}>
            {pred.homePercent}% {homeTeam.shortName}
          </span>
        </div>
      </div>

      {/* Just picked animation */}
      <AnimatePresence>
        {justPicked && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-2 text-center text-xs font-semibold text-accent"
          >
            ✅ 예측 완료! +5P
          </motion.div>
        )}
      </AnimatePresence>
    </GlassCard>
  );
}
