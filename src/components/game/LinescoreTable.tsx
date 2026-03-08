"use client";

import { motion } from "framer-motion";
import { clsx } from "clsx";
import type { GameInning } from "@/lib/types";
import type { TeamData } from "@/lib/constants/teams";

interface LinescoreTableProps {
  awayTeam: TeamData;
  homeTeam: TeamData;
  innings: GameInning[];
  awayScore: number;
  homeScore: number;
  currentInning: string | null;
  awayHits?: number;
  homeHits?: number;
  awayErrors?: number;
  homeErrors?: number;
}

export default function LinescoreTable({
  awayTeam,
  homeTeam,
  innings,
  awayScore,
  homeScore,
  currentInning,
  awayHits = 7,
  homeHits = 5,
  awayErrors = 0,
  homeErrors = 1,
}: LinescoreTableProps) {
  const maxInning = 9;
  const currentInningNum = currentInning
    ? parseInt(currentInning.replace(/[^0-9]/g, ""))
    : 0;

  const inningNumbers = Array.from(
    { length: Math.max(maxInning, innings.length) },
    (_, i) => i + 1
  );

  function getInningScore(inning: number, isTop: boolean): string {
    const data = innings.find((i) => i.inning === inning);
    if (!data) return "";
    const score = isTop ? data.topScore : data.bottomScore;
    return score !== null && score !== undefined ? String(score) : "";
  }

  return (
    <div className="px-4 mb-2.5">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-[#666] font-semibold">이닝별 스코어</span>
        <span className="text-[9px] text-[#555]">R 점수 · H 안타 · E 에러</span>
      </div>
      <div className="overflow-x-auto hide-scrollbar">
        <table className="w-full min-w-[360px] border-collapse text-[11px] tabular-nums">
          <thead>
            <tr>
              <th className="text-left pl-1 min-w-[36px] text-[#666] font-medium text-[10px] py-1" />
              {inningNumbers.map((n) => (
                <th
                  key={n}
                  className={clsx(
                    "min-w-[22px] py-1 text-center font-medium text-[10px]",
                    n === currentInningNum ? "text-[#4fc3f7]" : "text-[#666]"
                  )}
                >
                  {n}
                </th>
              ))}
              <th className="font-bold text-white border-l border-[#333] px-1.5 py-1 text-center">R</th>
              <th className="font-bold text-white border-l border-[#333] px-1.5 py-1 text-center">H</th>
              <th className="font-bold text-white border-l border-[#333] px-1.5 py-1 text-center">E</th>
            </tr>
          </thead>
          <tbody>
            {/* Away */}
            <tr className="border-b border-[#1a1a2e]">
              <td className="text-left pl-1 py-1 font-semibold text-xs" style={{ color: awayTeam.colorPrimary }}>
                {awayTeam.shortName}
              </td>
              {inningNumbers.map((n) => {
                const score = getInningScore(n, true);
                const isCurrent = n === currentInningNum && currentInning?.includes("초");
                return (
                  <td key={n} className={clsx("py-1 text-center", isCurrent ? "text-[#4fc3f7] font-bold" : "text-[#ccc]")}>
                    {score !== "" ? (
                      <motion.span
                        key={`a-${n}-${score}`}
                        initial={{ scale: 1.3, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                      >
                        {score}
                      </motion.span>
                    ) : (
                      <span className="text-[#444]">-</span>
                    )}
                  </td>
                );
              })}
              <td className="font-bold text-white border-l border-[#333] px-1.5 py-1 text-center">{awayScore}</td>
              <td className="font-bold text-white border-l border-[#333] px-1.5 py-1 text-center">{awayHits}</td>
              <td className="font-bold text-white border-l border-[#333] px-1.5 py-1 text-center">{awayErrors}</td>
            </tr>
            {/* Home */}
            <tr className="border-b border-[#1a1a2e]">
              <td className="text-left pl-1 py-1 font-semibold text-xs" style={{ color: homeTeam.colorLight || homeTeam.colorPrimary }}>
                {homeTeam.shortName}
              </td>
              {inningNumbers.map((n) => {
                const score = getInningScore(n, false);
                const isCurrent = n === currentInningNum && currentInning?.includes("말");
                return (
                  <td key={n} className={clsx("py-1 text-center", isCurrent ? "text-[#4fc3f7] font-bold" : "text-[#ccc]")}>
                    {score !== "" ? (
                      <motion.span
                        key={`h-${n}-${score}`}
                        initial={{ scale: 1.3, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                      >
                        {score}
                      </motion.span>
                    ) : (
                      <span className="text-[#444]">-</span>
                    )}
                  </td>
                );
              })}
              <td className="font-bold text-white border-l border-[#333] px-1.5 py-1 text-center">{homeScore}</td>
              <td className="font-bold text-white border-l border-[#333] px-1.5 py-1 text-center">{homeHits}</td>
              <td className="font-bold text-white border-l border-[#333] px-1.5 py-1 text-center">{homeErrors}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
