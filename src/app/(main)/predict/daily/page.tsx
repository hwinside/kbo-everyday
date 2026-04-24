"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Users } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getTeamById, getTeamBgColor } from "@/lib/constants/teams";
import { MOCK_PREDICTIONS } from "@/lib/constants/predictions";
import GlassCard from "@/components/ui/GlassCard";
import AIAnalysis from "@/components/game/AIAnalysis";

export default function DailyPredictPage() {
  const router = useRouter();
  const [aiTarget, setAiTarget] = useState<{ away: number; home: number; gameId: string } | null>(null);

  return (
    <div className="min-h-screen bg-bg-primary pb-24">
      <div className="px-5 pt-safe pb-3 flex items-center gap-3">
        <button onClick={() => router.back()} className="p-1">
          <ArrowLeft size={24} className="text-text-primary" />
        </button>
        <h1 className="text-lg font-bold text-text-primary">오늘의 승부예측</h1>
      </div>

      <div className="px-5 space-y-4">
        {MOCK_PREDICTIONS.map((pred) => {
          const away = getTeamById(pred.awayTeamId)!;
          const home = getTeamById(pred.homeTeamId)!;

          return (
            <GlassCard key={pred.gameId} className="p-5">
              {/* Teams */}
              <div className="flex items-center justify-between mb-4">
                <Link href={`/games/${pred.gameId}/predict`} className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-black/8 dark:bg-white/10 flex items-center justify-center p-1.5">
                    <Image src={away.logoPath} alt={away.name} width={36} height={36} unoptimized />
                  </div>
                  <span className="text-sm font-bold" style={{ color: away.colorLight || away.colorPrimary }}>{away.shortName}</span>
                </Link>

                <div className="text-center">
                  <span className="text-lg font-black text-text-tertiary">VS</span>
                  <div className="text-[10px] text-text-tertiary mt-0.5">{pred.time || "18:30"}</div>
                </div>

                <Link href={`/games/${pred.gameId}/predict`} className="flex items-center gap-3">
                  <span className="text-sm font-bold" style={{ color: home.colorLight || home.colorPrimary }}>{home.shortName}</span>
                  <div className="w-12 h-12 rounded-xl bg-black/8 dark:bg-white/10 flex items-center justify-center p-1.5">
                    <Image src={home.logoPath} alt={home.name} width={36} height={36} unoptimized />
                  </div>
                </Link>
              </div>

              {/* Vote bar */}
              <div className="flex h-8 overflow-hidden rounded-xl mb-2">
                <motion.div
                  className="flex items-center justify-center rounded-l-xl"
                  initial={{ width: 0 }}
                  animate={{ width: `${pred.awayPercent}%` }}
                  transition={{ duration: 0.8, ease: "easeOut" }}
                  style={{ backgroundColor: getTeamBgColor(away) }}
                >
                  <span className="text-xs font-bold text-white drop-shadow">{pred.awayPercent}%</span>
                </motion.div>
                <motion.div
                  className="flex items-center justify-center rounded-r-xl"
                  initial={{ width: 0 }}
                  animate={{ width: `${pred.homePercent}%` }}
                  transition={{ duration: 0.8, ease: "easeOut", delay: 0.1 }}
                  style={{ backgroundColor: getTeamBgColor(home) }}
                >
                  <span className="text-xs font-bold text-white drop-shadow">{pred.homePercent}%</span>
                </motion.div>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-xs text-text-tertiary flex items-center gap-1">
                  <Users size={12} /> {pred.totalVotes.toLocaleString()}명 참여
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setAiTarget({ away: pred.awayTeamId, home: pred.homeTeamId, gameId: pred.gameId })}
                    className="px-3 py-1.5 rounded-full bg-accent/20 text-accent text-xs font-semibold"
                  >
                    🤖 AI 분석
                  </button>
                  <Link
                    href={`/games/${pred.gameId}/predict`}
                    className="px-3 py-1.5 rounded-full bg-black/8 dark:bg-white/10 text-text-primary text-xs font-semibold"
                  >
                    투표하기 →
                  </Link>
                </div>
              </div>
            </GlassCard>
          );
        })}
      </div>

      {aiTarget && (
        <AIAnalysis
          isOpen={true}
          onClose={() => setAiTarget(null)}
          awayTeamId={aiTarget.away}
          homeTeamId={aiTarget.home}
          gameId={aiTarget.gameId}
        />
      )}
    </div>
  );
}
