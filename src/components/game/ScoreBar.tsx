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

  return (
    <div
      className="sticky top-[60px] z-[99] border-b border-[#1a1a2e] px-4 py-3 flex items-center justify-center gap-3"
      style={{
        background: "rgba(10,10,15,0.92)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
      }}
    >
      {/* Away team */}
      <div className="flex items-center gap-2 flex-1 justify-end">
        <span className="text-[16px] font-semibold text-white">{awayTeam.shortName}</span>
        <TeamLogo team={awayTeam} size={36} />
      </div>

      {/* Center: score + inning */}
      <div className="flex flex-col items-center min-w-[100px]">
        <div className="flex items-center gap-2">
          <motion.span
            key={`sb-away-${awayScore}`}
            initial={{ scale: 1.3, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className={`text-[32px] font-extrabold tabular-nums ${awayWinning ? "text-[#4fc3f7]" : "text-white"}`}
          >
            {awayScore}
          </motion.span>
          <span className="text-lg text-[#555]">:</span>
          <motion.span
            key={`sb-home-${homeScore}`}
            initial={{ scale: 1.3, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className={`text-[32px] font-extrabold tabular-nums ${homeWinning ? "text-[#4fc3f7]" : "text-white"}`}
          >
            {homeScore}
          </motion.span>
        </div>
        {/* Inning badge */}
        <span className="text-[10px] font-semibold text-[#e53935] bg-[#e5393522] px-1.5 py-px rounded-lg">
          {currentInning}
        </span>
      </div>

      {/* Home team */}
      <div className="flex items-center gap-2 flex-1 justify-start">
        <TeamLogo team={homeTeam} size={36} />
        <span className="text-[16px] font-semibold text-white">{homeTeam.shortName}</span>
      </div>
    </div>
  );
}
