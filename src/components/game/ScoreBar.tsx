"use client";

import { motion } from "framer-motion";
import TeamLogo from "@/components/ui/TeamLogo";
import type { TeamData } from "@/lib/constants/teams";

interface ScoreBarProps {
  awayTeam: TeamData;
  homeTeam: TeamData;
  awayScore: number;
  homeScore: number;
  currentInning: string;
}

export default function ScoreBar({
  awayTeam,
  homeTeam,
  awayScore,
  homeScore,
  currentInning,
}: ScoreBarProps) {
  const awayWinning = awayScore > homeScore;
  const homeWinning = homeScore > awayScore;
  // 두 자리 이상 점수에서 팀명이 세로로 줄바꿈되지 않도록 폰트 크기를 양쪽 동일하게 축소
  const maxScore = Math.max(awayScore, homeScore);
  const scoreSize = maxScore >= 100 ? "text-[32px]" : maxScore >= 10 ? "text-[40px]" : "text-[48px]";

  return (
    <div
      className="sticky top-[36px] z-[99] border-b border-border px-4 py-2"
      style={{
        background: "var(--scorebar-bg, rgba(10,10,15,0.92))",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
      }}
    >
      {/* Single row: logo name score : inning : score name logo */}
      <div className="flex items-center justify-center gap-0">
        {/* Away side */}
        <div className="flex items-center gap-2.5 flex-1 justify-end">
          <span className="text-lg font-bold text-text-primary whitespace-nowrap">{awayTeam.shortName}</span>
          <TeamLogo team={awayTeam} size={40} />
          <motion.span
            key={`sb-away-${awayScore}`}
            initial={{ scale: 1.3, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className={`${scoreSize} shrink-0 font-extrabold tabular-nums leading-none ${awayWinning ? "text-[#4fc3f7]" : "text-text-primary"}`}
          >
            {awayScore}
          </motion.span>
        </div>

        {/* Center divider + inning */}
        <div className="flex flex-col items-center mx-3">
          <span className="text-xl text-text-tertiary font-light leading-none">:</span>
          <span className="text-[9px] font-semibold text-[#e53935] bg-[#e5393522] px-1.5 py-px rounded-md mt-1 whitespace-nowrap">
            {currentInning}
          </span>
        </div>

        {/* Home side */}
        <div className="flex items-center gap-2.5 flex-1 justify-start">
          <motion.span
            key={`sb-home-${homeScore}`}
            initial={{ scale: 1.3, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className={`${scoreSize} shrink-0 font-extrabold tabular-nums leading-none ${homeWinning ? "text-[#4fc3f7]" : "text-text-primary"}`}
          >
            {homeScore}
          </motion.span>
          <TeamLogo team={homeTeam} size={40} />
          <span className="text-lg font-bold text-text-primary whitespace-nowrap">{homeTeam.shortName}</span>
        </div>
      </div>
    </div>
  );
}
