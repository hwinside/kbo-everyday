"use client";

import { motion } from "framer-motion";
import { Flame, Trophy, Zap } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";

interface PredictionResultProps {
  totalCorrect: number;
  totalPredictions: number;
  currentStreak: number;
  todayPoints: number;
  points: number;
}

export default function PredictionResult({
  totalCorrect,
  totalPredictions,
  currentStreak,
  todayPoints,
  points,
}: PredictionResultProps) {
  const accuracy = totalPredictions > 0 ? Math.round((totalCorrect / totalPredictions) * 100) : 0;

  return (
    <GlassCard className="relative overflow-hidden p-5">
      {/* Confetti-like particles for streaks */}
      {currentStreak >= 3 && (
        <div className="pointer-events-none absolute inset-0">
          {Array.from({ length: 8 }).map((_, i) => (
            <motion.div
              key={i}
              className="absolute h-1 w-1 rounded-full"
              style={{
                backgroundColor: i % 2 === 0 ? "#FFD60A" : "#FF453A",
                left: `${10 + i * 12}%`,
                top: "-4px",
              }}
              animate={{
                y: [0, 60 + Math.random() * 40],
                x: [0, (Math.random() - 0.5) * 30],
                opacity: [1, 0],
                scale: [1, 0.5],
              }}
              transition={{
                duration: 1.5 + Math.random(),
                repeat: Infinity,
                delay: Math.random() * 2,
                ease: "easeOut",
              }}
            />
          ))}
        </div>
      )}

      <div className="relative flex items-center justify-between">
        <div>
          <p className="text-base text-text-secondary">내 예측 현황</p>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-2xl font-bold tabular-nums text-text-primary">
              {totalCorrect}
            </span>
            <span className="text-base text-text-tertiary">/ {totalPredictions}</span>
            <span className="ml-1 text-base font-semibold text-accent-gold">
              ({accuracy}%)
            </span>
          </div>
        </div>

        {/* Streak */}
        <div className="text-right">
          {currentStreak > 0 && (
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="flex items-center gap-1"
            >
              <Flame size={22} className="text-orange-500" />
              <span className="text-base font-bold text-orange-400">
                {currentStreak}연속 적중
              </span>
            </motion.div>
          )}
          {todayPoints > 0 && (
            <motion.div
              initial={{ y: -10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.2 }}
              className="mt-1 flex items-center justify-end gap-1"
            >
              <Zap size={22} className="text-accent-gold" />
              <span className="text-base font-semibold text-accent-gold">
                오늘 +{todayPoints}p
              </span>
            </motion.div>
          )}
        </div>
      </div>

      {/* Stats row */}
      <div className="mt-4 grid grid-cols-3 gap-3">
        <div className="rounded-lg bg-bg-tertiary/50 p-5 text-center">
          <p className="text-base text-text-tertiary">총 포인트</p>
          <p className="mt-0.5 text-base font-bold tabular-nums text-text-primary">
            {points.toLocaleString()}p
          </p>
        </div>
        <div className="rounded-lg bg-bg-tertiary/50 p-5 text-center">
          <p className="text-base text-text-tertiary">적중률</p>
          <p className="mt-0.5 text-base font-bold tabular-nums text-accent-gold">
            {accuracy}%
          </p>
        </div>
        <div className="rounded-lg bg-bg-tertiary/50 p-5 text-center">
          <p className="text-base text-text-tertiary">연속</p>
          <p className="mt-0.5 text-base font-bold tabular-nums text-orange-400">
            {currentStreak}회
          </p>
        </div>
      </div>
    </GlassCard>
  );
}
