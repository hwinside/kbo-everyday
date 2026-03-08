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
  balls: number;
  strikes: number;
  outs: number;
  runner1b: boolean;
  runner2b: boolean;
  runner3b: boolean;
}

export default function ScoreBar({
  awayTeam,
  homeTeam,
  awayScore,
  homeScore,
  currentInning,
  balls,
  strikes,
  outs,
  runner1b,
  runner2b,
  runner3b,
}: ScoreBarProps) {
  const awayWinning = awayScore > homeScore;
  const homeWinning = homeScore > awayScore;

  return (
    <div
      className="sticky top-[60px] z-[99] border-b border-[#1a1a2e] px-4 py-2 flex items-center justify-center gap-2.5"
      style={{
        background: "rgba(10,10,15,0.92)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
      }}
    >
      {/* Away team */}
      <div className="flex items-center gap-1.5 flex-1 justify-end">
        <span className="text-[13px] font-semibold text-white">{awayTeam.shortName}</span>
        <TeamLogo team={awayTeam} size={26} />
      </div>

      {/* Center: score + inning + BSO + bases */}
      <div className="flex flex-col items-center min-w-[100px]">
        <div className="flex items-center gap-1.5">
          <motion.span
            key={`sb-away-${awayScore}`}
            initial={{ scale: 1.3, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className={`text-2xl font-extrabold tabular-nums ${awayWinning ? "text-[#4fc3f7]" : "text-white"}`}
          >
            {awayScore}
          </motion.span>
          <span className="text-base text-[#555]">:</span>
          <motion.span
            key={`sb-home-${homeScore}`}
            initial={{ scale: 1.3, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className={`text-2xl font-extrabold tabular-nums ${homeWinning ? "text-[#4fc3f7]" : "text-white"}`}
          >
            {homeScore}
          </motion.span>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          {/* Inning badge */}
          <span className="text-[10px] font-semibold text-[#e53935] bg-[#e5393522] px-1.5 py-px rounded-lg">
            {currentInning}
          </span>
          {/* BSO text */}
          <div className="flex items-center gap-2 text-[11px] text-[#888] tabular-nums">
            <span>
              <span className="text-[#4caf50] font-semibold">{balls}</span>B
            </span>
            <span>
              <span className="text-[#ffc107] font-semibold">{strikes}</span>S
            </span>
            <span className="inline-flex gap-0.5">
              {[0, 1].map((i) => (
                <span
                  key={i}
                  className={`inline-block w-[7px] h-[7px] rounded-full ${
                    i < outs ? "bg-[#e53935]" : "bg-[#333]"
                  }`}
                />
              ))}
            </span>
          </div>
          {/* Mini runner diamond */}
          <div className="flex flex-col items-center gap-px ml-1">
            <div className="flex gap-px">
              <div
                className={`w-[7px] h-[7px] rotate-45 ${runner2b ? "bg-[#ffd600]" : "bg-[#333]"}`}
              />
            </div>
            <div className="flex gap-px">
              <div
                className={`w-[7px] h-[7px] rotate-45 ${runner3b ? "bg-[#ffd600]" : "bg-[#333]"}`}
              />
              <div
                className={`w-[7px] h-[7px] rotate-45 ${runner1b ? "bg-[#ffd600]" : "bg-[#333]"}`}
              />
            </div>
            <div className="flex gap-px">
              <div className="w-[7px] h-[7px] rotate-45 bg-[#333]" />
            </div>
          </div>
        </div>
      </div>

      {/* Home team */}
      <div className="flex items-center gap-1.5 flex-1 justify-start">
        <TeamLogo team={homeTeam} size={26} />
        <span className="text-[13px] font-semibold text-white">{homeTeam.shortName}</span>
      </div>
    </div>
  );
}
