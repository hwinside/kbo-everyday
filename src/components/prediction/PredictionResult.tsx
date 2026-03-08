"use client";

import { motion } from "framer-motion";
import { Flame, Zap, ChevronRight } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { getGradeByPoints, getNextGrade, getProgressToNext, POINT_RULES } from "@/lib/constants/grades";

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
  const grade = getGradeByPoints(points);
  const nextGrade = getNextGrade(points);
  const progress = getProgressToNext(points);

  return (
    <GlassCard className="relative overflow-hidden p-5">
      {/* Confetti for streaks */}
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
              /* eslint-disable react-hooks/purity */
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
              /* eslint-enable react-hooks/purity */
            />
          ))}
        </div>
      )}

      {/* Grade badge + points header */}
      <div className="relative flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", stiffness: 300 }}
            className="flex h-12 w-12 items-center justify-center rounded-2xl text-2xl"
            style={{ backgroundColor: grade.bgColor }}
          >
            {grade.emoji}
          </motion.div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold" style={{ color: grade.color }}>{grade.name}</span>
              {todayPoints > 0 && (
                <motion.span
                  initial={{ y: -10, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  className="flex items-center gap-0.5 text-xs font-semibold text-accent-gold"
                >
                  <Zap size={12} /> +{todayPoints}p
                </motion.span>
              )}
            </div>
            <span className="text-sm tabular-nums text-text-secondary">{points.toLocaleString()}P</span>
          </div>
        </div>

        {/* Streak */}
        {currentStreak > 0 && (
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="flex items-center gap-1 rounded-full px-3 py-1.5 bg-orange-500/15"
          >
            <Flame size={16} className="text-orange-400" />
            <span className="text-sm font-bold text-orange-400 tabular-nums">{currentStreak}연속</span>
          </motion.div>
        )}
      </div>

      {/* Progress to next grade */}
      {nextGrade && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs text-text-tertiary">다음 등급</span>
            <span className="flex items-center gap-1 text-xs" style={{ color: nextGrade.color }}>
              {nextGrade.emoji} {nextGrade.name}
              <span className="text-text-tertiary">({nextGrade.minPoints - points}P 남음)</span>
            </span>
          </div>
          <div className="h-2 rounded-full bg-bg-tertiary overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 1, ease: "easeOut" }}
              className="h-full rounded-full"
              style={{ backgroundColor: grade.color }}
            />
          </div>
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-xl bg-bg-tertiary/50 p-3 text-center">
          <p className="text-xs text-text-tertiary">적중</p>
          <p className="text-base font-bold tabular-nums text-text-primary">
            {totalCorrect}<span className="text-xs text-text-tertiary">/{totalPredictions}</span>
          </p>
        </div>
        <div className="rounded-xl bg-bg-tertiary/50 p-3 text-center">
          <p className="text-xs text-text-tertiary">적중률</p>
          <p className="text-base font-bold tabular-nums text-accent-gold">{accuracy}%</p>
        </div>
        <div className="rounded-xl bg-bg-tertiary/50 p-3 text-center">
          <p className="text-xs text-text-tertiary">연속</p>
          <p className="text-base font-bold tabular-nums text-orange-400">{currentStreak}회</p>
        </div>
      </div>

      {/* Point rules hint */}
      <div className="mt-3 flex items-center justify-between rounded-xl bg-bg-tertiary/30 px-3 py-2">
        <div className="flex gap-3 text-xs text-text-tertiary">
          <span>예측 <span className="text-accent">+{POINT_RULES.predict}P</span></span>
          <span>적중 <span className="text-accent-gold">+{POINT_RULES.correct}P</span></span>
          <span>3연속 <span className="text-orange-400">+{POINT_RULES.streak3}P</span></span>
        </div>
        <ChevronRight size={14} className="text-text-tertiary" />
      </div>
    </GlassCard>
  );
}
