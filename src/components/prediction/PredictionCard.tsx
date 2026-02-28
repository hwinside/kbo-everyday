"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Clock, Lock, Users } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import TeamLogo from "@/components/ui/TeamLogo";
import { getTeamById } from "@/lib/constants/teams";
import type { PredictionMock } from "@/lib/constants/predictions";

interface PredictionCardProps {
  prediction: PredictionMock;
}

export default function PredictionCard({ prediction }: PredictionCardProps) {
  const [myPick, setMyPick] = useState<number | null>(prediction.myPick);
  const [totalVotes, setTotalVotes] = useState(prediction.totalVotes);
  const [homePercent, setHomePercent] = useState(prediction.homePercent);
  const [awayPercent, setAwayPercent] = useState(prediction.awayPercent);

  const homeTeam = getTeamById(prediction.homeTeamId);
  const awayTeam = getTeamById(prediction.awayTeamId);
  const isLocked = prediction.status === "locked";
  const isFinished = prediction.status === "finished";
  const canVote = prediction.status === "open" && myPick === null;

  if (!homeTeam || !awayTeam) return null;

  function handleVote(teamId: number) {
    if (!canVote) return;
    setMyPick(teamId);
    setTotalVotes((v) => v + 1);
    // Simulate slight % shift
    if (teamId === prediction.homeTeamId) {
      setHomePercent((p) => Math.min(p + 1, 99));
      setAwayPercent((p) => Math.max(p - 1, 1));
    } else {
      setAwayPercent((p) => Math.min(p + 1, 99));
      setHomePercent((p) => Math.max(p - 1, 1));
    }
  }

  const isCorrect = isFinished && myPick === prediction.winnerTeamId;
  const isWrong = isFinished && myPick !== null && myPick !== prediction.winnerTeamId;

  return (
    <GlassCard
      className={`relative overflow-hidden p-5 ${
        isCorrect ? "ring-1 ring-accent-gold/40" : ""
      } ${isWrong ? "opacity-80" : ""}`}
    >
      {/* Correct background glow */}
      {isCorrect && (
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-accent-gold/10 to-transparent" />
      )}

      {/* Header: time + status */}
      <div className="mb-4 flex items-center justify-between relative">
        <div className="flex items-center gap-4 text-base text-text-secondary">
          <Clock size={22} />
          <span>{prediction.time} · {prediction.stadium}</span>
        </div>
        {isLocked && (
          <span className="flex items-center gap-1 text-base text-text-tertiary">
            <Lock size={22} />
            진행중
          </span>
        )}
        {isFinished && prediction.homeScore !== null && prediction.awayScore !== null && (
          <span className="text-base font-semibold text-text-secondary">
            {prediction.awayScore} : {prediction.homeScore}
          </span>
        )}
      </div>

      {/* Teams and vote buttons */}
      <div className="relative flex items-center gap-4">
        {/* Away team */}
        <button
          onClick={() => handleVote(prediction.awayTeamId)}
          disabled={!canVote}
          className="flex-1 rounded-xl py-3 text-center transition-all duration-300"
          style={{
            backgroundColor:
              myPick === prediction.awayTeamId
                ? `${awayTeam.colorPrimary}20`
                : "transparent",
            border: `2px solid ${
              myPick === prediction.awayTeamId
                ? awayTeam.colorPrimary
                : "rgba(255,255,255,0.08)"
            }`,
          }}
        >
          <motion.div
            animate={
              myPick === prediction.awayTeamId
                ? { scale: [1, 1.05, 1] }
                : {}
            }
            transition={{ duration: 0.3 }}
            className="flex flex-col items-center"
          >
            <TeamLogo team={awayTeam} size={52} className="mb-1" />
            <div
              className="text-lg font-bold"
              style={{
                color:
                  myPick === prediction.awayTeamId
                    ? awayTeam.colorPrimary
                    : "var(--text-primary)",
              }}
            >
              {awayTeam.shortName}
            </div>
            <div className="mt-0.5 text-base text-text-secondary">
              {isFinished && prediction.winnerTeamId === prediction.awayTeamId && "👑 "}
              승리
            </div>
          </motion.div>
        </button>

        <span className="text-base font-semibold text-text-tertiary">VS</span>

        {/* Home team */}
        <button
          onClick={() => handleVote(prediction.homeTeamId)}
          disabled={!canVote}
          className="flex-1 rounded-xl py-3 text-center transition-all duration-300"
          style={{
            backgroundColor:
              myPick === prediction.homeTeamId
                ? `${homeTeam.colorPrimary}20`
                : "transparent",
            border: `2px solid ${
              myPick === prediction.homeTeamId
                ? homeTeam.colorPrimary
                : "rgba(255,255,255,0.08)"
            }`,
          }}
        >
          <motion.div
            animate={
              myPick === prediction.homeTeamId
                ? { scale: [1, 1.05, 1] }
                : {}
            }
            transition={{ duration: 0.3 }}
            className="flex flex-col items-center"
          >
            <TeamLogo team={homeTeam} size={52} className="mb-1" />
            <div
              className="text-lg font-bold"
              style={{
                color:
                  myPick === prediction.homeTeamId
                    ? homeTeam.colorPrimary
                    : "var(--text-primary)",
              }}
            >
              {homeTeam.shortName}
            </div>
            <div className="mt-0.5 text-base text-text-secondary">
              {isFinished && prediction.winnerTeamId === prediction.homeTeamId && "👑 "}
              승리
            </div>
          </motion.div>
        </button>
      </div>

      {/* Prediction bar */}
      <div className="mt-4">
        <div className="flex h-2.5 overflow-hidden rounded-full">
          <motion.div
            className="rounded-l-full"
            initial={{ width: 0 }}
            animate={{ width: `${awayPercent}%` }}
            transition={{ duration: 0.8, ease: "easeOut" }}
            style={{ backgroundColor: awayTeam.colorPrimary }}
          />
          <motion.div
            className="rounded-r-full"
            initial={{ width: 0 }}
            animate={{ width: `${homePercent}%` }}
            transition={{ duration: 0.8, ease: "easeOut", delay: 0.1 }}
            style={{ backgroundColor: homeTeam.colorPrimary }}
          />
        </div>
        <div className="mt-1.5 flex items-center justify-between text-base">
          <span style={{ color: awayTeam.colorPrimary }} className="font-semibold">
            {awayTeam.shortName} {awayPercent}%
          </span>
          <span className="flex items-center gap-1 text-text-tertiary">
            <Users size={22} />
            {totalVotes.toLocaleString()}명
          </span>
          <span style={{ color: homeTeam.colorPrimary }} className="font-semibold">
            {homePercent}% {homeTeam.shortName}
          </span>
        </div>
      </div>

      {/* Result badge */}
      <AnimatePresence>
        {isCorrect && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-4 flex items-center justify-center gap-4 rounded-lg bg-accent-gold/10 py-2 text-base font-semibold text-accent-gold"
          >
            ✅ 적중! +10 포인트
          </motion.div>
        )}
        {isWrong && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-4 flex items-center justify-center gap-4 rounded-lg bg-bg-tertiary py-2 text-base text-text-secondary"
          >
            ❌ 오답
          </motion.div>
        )}
      </AnimatePresence>
    </GlassCard>
  );
}
