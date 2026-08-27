"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useSafeBack } from "@/lib/hooks/useSafeBack";
import { motion } from "framer-motion";
import { ArrowLeft, Users, Trophy } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { getTeamById, isAllStarGameId } from "@/lib/constants/teams";
import { MOCK_PREDICTIONS } from "@/lib/constants/predictions";
import GlassCard from "@/components/ui/GlassCard";
import AIAnalysis from "@/components/game/AIAnalysis";

export default function GamePredictPage() {
  const params = useParams();
  const gameId = params.gameId as string;
  const goBack = useSafeBack(`/games/${gameId}`);
  const [aiOpen, setAiOpen] = useState(false);
  const [voted, setVoted] = useState<"away" | "home" | null>(null);

  // 올스타전은 승부예측 미제공(팀기반 예측이 나눔/드림에 무의미).
  if (isAllStarGameId(gameId)) {
    return <div className="p-8 text-center text-text-tertiary">올스타전은 승부예측을 제공하지 않습니다</div>;
  }

  const pred = MOCK_PREDICTIONS.find((p) => p.gameId === gameId);
  if (!pred) return <div className="p-8 text-center text-text-tertiary">예측 정보가 없습니다</div>;

  const away = getTeamById(pred.awayTeamId)!;
  const home = getTeamById(pred.homeTeamId)!;
  const totalVotes = pred.totalVotes + (voted ? 1 : 0);
  const awayPct = voted === "away" ? Math.round((pred.awayPercent * pred.totalVotes + 100) / totalVotes) : pred.awayPercent;
  const homePct = voted === "home" ? Math.round((pred.homePercent * pred.totalVotes + 100) / totalVotes) : pred.homePercent;

  return (
    <div className="min-h-screen bg-bg-primary pb-24">
      {/* Header (page-root 직속 child로 명시적 분리 — 짧은 hero wrapper에 sticky가 갇히지 않도록) */}
      <div className="sticky top-0 z-30 border-b border-border bg-bg-primary px-5 flex items-center gap-3 min-h-[44px]" style={{ paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
        <button onClick={goBack} aria-label="뒤로가기" className="flex h-11 w-11 items-center justify-center -ml-2">
          <ArrowLeft size={24} className="text-text-primary" />
        </button>
        <h1 className="text-lg font-bold text-text-primary">승부예측</h1>
      </div>

      {/* Hero */}
      <div
        className="relative px-5 pb-4 pt-4"
        style={{
          backgroundImage: `linear-gradient(135deg, ${away.colorPrimary}15, transparent, ${home.colorPrimary}15)`,
        }}
      >
        {/* Match Card */}
        <div className="flex items-center justify-between px-6">
          <button
            onClick={() => setVoted("away")}
            className={`flex flex-col items-center gap-3 transition-all ${voted === "away" ? "scale-110" : voted === "home" ? "opacity-40" : ""}`}
          >
            <div
              className={`w-20 h-20 rounded-2xl bg-black/8 dark:bg-white/10 flex items-center justify-center p-2 border-2 transition-colors ${voted === "away" ? "border-accent shadow-lg" : "border-transparent"}`}
              style={voted === "away" ? { boxShadow: `0 0 20px ${away.colorPrimary}40` } : {}}
            >
              <Image src={away.logoPath} alt={away.name} width={56} height={56} unoptimized />
            </div>
            <span className="text-base font-bold" style={{ color: away.colorLight || away.colorPrimary }}>{away.shortName}</span>
          </button>

          <div className="text-center">
            <div className="text-2xl font-black text-text-tertiary">VS</div>
            <div className="text-xs text-text-tertiary mt-1">누가 이길까?</div>
          </div>

          <button
            onClick={() => setVoted("home")}
            className={`flex flex-col items-center gap-3 transition-all ${voted === "home" ? "scale-110" : voted === "away" ? "opacity-40" : ""}`}
          >
            <div
              className={`w-20 h-20 rounded-2xl bg-black/8 dark:bg-white/10 flex items-center justify-center p-2 border-2 transition-colors ${voted === "home" ? "border-accent shadow-lg" : "border-transparent"}`}
              style={voted === "home" ? { boxShadow: `0 0 20px ${home.colorPrimary}40` } : {}}
            >
              <Image src={home.logoPath} alt={home.name} width={56} height={56} unoptimized />
            </div>
            <span className="text-base font-bold" style={{ color: home.colorLight || home.colorPrimary }}>{home.shortName}</span>
          </button>
        </div>
      </div>

      {/* Vote Result */}
      <div className="px-5 mt-6">
        <GlassCard className="p-5">
          <div className="flex justify-between items-center mb-3">
            <span className="text-sm font-bold text-text-primary">투표 현황</span>
            <span className="flex items-center gap-1 text-xs text-text-tertiary">
              <Users size={14} /> {totalVotes.toLocaleString()}명 참여
            </span>
          </div>

          {/* Bar */}
          <div className="flex h-10 overflow-hidden rounded-xl">
            <motion.div
              className="flex items-center justify-center rounded-l-xl"
              initial={{ width: 0 }}
              animate={{ width: `${awayPct}%` }}
              transition={{ duration: 0.8, ease: "easeOut" }}
              style={{ backgroundColor: away.colorPrimary }}
            >
              <span className="text-sm font-bold text-white drop-shadow">{awayPct}%</span>
            </motion.div>
            <motion.div
              className="flex items-center justify-center rounded-r-xl"
              initial={{ width: 0 }}
              animate={{ width: `${homePct}%` }}
              transition={{ duration: 0.8, ease: "easeOut", delay: 0.1 }}
              style={{ backgroundColor: home.colorPrimary }}
            >
              <span className="text-sm font-bold text-white drop-shadow">{homePct}%</span>
            </motion.div>
          </div>

          <div className="flex justify-between mt-2 text-xs">
            <span style={{ color: away.colorLight || away.colorPrimary }} className="font-semibold">{away.shortName}</span>
            <span style={{ color: home.colorLight || home.colorPrimary }} className="font-semibold">{home.shortName}</span>
          </div>

          {voted && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-3 text-center text-sm text-accent font-semibold"
            >
              ✅ {voted === "away" ? away.shortName : home.shortName} 승리에 투표했습니다!
            </motion.div>
          )}
        </GlassCard>
      </div>

      {/* AI 분석 */}
      <div className="px-5 mt-4">
        <button
          onClick={() => setAiOpen(true)}
          className="w-full py-3 rounded-xl bg-accent/20 text-accent text-base font-semibold flex items-center justify-center gap-2 hover:bg-accent/30 transition-colors"
        >
          🤖 AI 분석 보기
        </button>
      </div>

      <AIAnalysis isOpen={aiOpen} onClose={() => setAiOpen(false)} awayTeamId={pred.awayTeamId} homeTeamId={pred.homeTeamId} gameId={gameId} />

      {/* 경기 상세 링크 */}
      <div className="px-5 mt-4">
        <Link href={`/games/${gameId}`}>
          <GlassCard pressable className="p-4 text-center">
            <span className="text-sm text-text-secondary">📊 경기 상세 보기 →</span>
          </GlassCard>
        </Link>
      </div>
    </div>
  );
}
