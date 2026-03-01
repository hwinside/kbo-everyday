"use client";

import { motion } from "framer-motion";
import { ChevronLeft, Trophy } from "lucide-react";
import Link from "next/link";
import PredictionCard from "@/components/prediction/PredictionCard";
import PredictionResult from "@/components/prediction/PredictionResult";
import { useState } from "react";
import AIAnalysis from "@/components/game/AIAnalysis";
import { MOCK_PREDICTIONS, MY_PREDICTION_STATS } from "@/lib/constants/predictions";

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
};

const item = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35 } },
};

export default function PredictPage() {
  const [aiGame, setAiGame] = useState<{awayTeamId: number; homeTeamId: number} | null>(null);
  return (
    <>
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="mx-auto max-w-lg px-5 pt-safe"
    >
      {/* Header */}
      <motion.header variants={item} className="flex items-center justify-between py-5">
        <div className="flex items-center gap-3">
          <Link href="/" className="rounded-full p-1 text-text-secondary hover:bg-bg-tertiary transition-colors">
            <ChevronLeft size={24} />
          </Link>
          <h1 className="text-xl font-bold text-text-primary">승부예측</h1>
        </div>
        <Link
          href="/predict/leaderboard"
          className="flex items-center gap-4 rounded-full bg-accent-gold/10 px-4 py-2 text-base font-semibold text-accent-gold transition-colors hover:bg-accent-gold/20"
        >
          <Trophy size={20} />
          랭킹
        </Link>
      </motion.header>

      {/* My stats */}
      <motion.div variants={item} className="mb-5">
        <PredictionResult
          totalCorrect={MY_PREDICTION_STATS.totalCorrect}
          totalPredictions={MY_PREDICTION_STATS.totalPredictions}
          currentStreak={MY_PREDICTION_STATS.currentStreak}
          todayPoints={MY_PREDICTION_STATS.todayPoints}
          points={MY_PREDICTION_STATS.points}
        />
      </motion.div>

      {/* Section header */}
      <motion.div variants={item} className="mb-4">
        <h2 className="text-lg font-semibold text-text-primary">
          오늘의 경기 <span className="text-text-tertiary text-base font-normal">3월 28일</span>
        </h2>
      </motion.div>

      {/* Prediction cards */}
      <div className="space-y-4 pb-8">
        {MOCK_PREDICTIONS.map((pred) => (
          <motion.div key={pred.gameId} variants={item}>
            <PredictionCard prediction={pred} />
            <button
              onClick={() => setAiGame({ awayTeamId: pred.awayTeamId, homeTeamId: pred.homeTeamId })}
              className="mt-2 w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-accent/10 text-accent text-sm font-semibold transition-colors hover:bg-accent/20"
            >
              🤖 AI훈수
            </button>
          </motion.div>
        ))}
      </div>
    </motion.div>

      {aiGame && (
        <AIAnalysis
          isOpen={true}
          onClose={() => setAiGame(null)}
          awayTeamId={aiGame.awayTeamId}
          homeTeamId={aiGame.homeTeamId}
        />
      )}
    </>
  );
}
