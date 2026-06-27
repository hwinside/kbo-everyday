"use client";

import { motion } from "framer-motion";
import { clsx } from "clsx";
import type { GameInning } from "@/lib/types";
import { type TeamData } from "@/lib/constants/teams";
import TeamLogo from "@/components/ui/TeamLogo";

interface ScoreBoardProps {
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

export default function ScoreBoard({
  awayTeam,
  homeTeam,
  innings,
  awayScore,
  homeScore,
  currentInning,
  awayHits,
  homeHits,
  awayErrors,
  homeErrors,
}: ScoreBoardProps) {
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
    <div className="overflow-x-auto hide-scrollbar">
      <table className="w-full min-w-[360px] text-center text-sm tabular-nums">
        <thead>
          <tr className="text-text-tertiary">
            <th className="w-14 py-1.5 text-left pl-1 font-medium">팀</th>
            {inningNumbers.map((n) => (
              <th
                key={n}
                className={clsx(
                  "w-7 py-1.5 font-medium",
                  n === currentInningNum && "text-accent"
                )}
              >
                {n}
              </th>
            ))}
            <th className="w-7 py-1.5 font-bold text-text-secondary">R</th>
            <th className="w-7 py-1.5 font-bold text-text-secondary">H</th>
            <th className="w-7 py-1.5 font-bold text-text-secondary">E</th>
          </tr>
        </thead>
        <tbody>
          {/* Away team */}
          <tr>
            <td className="py-1.5 text-left pl-1">
              <div className="flex items-center gap-2">
                <TeamLogo team={awayTeam} size={24} />
                <span className="font-semibold text-text-primary text-base whitespace-nowrap">
                  {awayTeam.shortName}
                </span>
              </div>
            </td>
            {inningNumbers.map((n) => {
              const score = getInningScore(n, true);
              return (
                <td
                  key={n}
                  className={clsx(
                    "py-1.5",
                    n === currentInningNum && currentInning?.includes("초")
                      ? "text-accent font-bold"
                      : "text-text-primary"
                  )}
                >
                  {score !== "" ? (
                    <motion.span
                      key={`away-${n}-${score}`}
                      initial={{ scale: 1.3, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: "spring", stiffness: 300, damping: 20 }}
                    >
                      {score}
                    </motion.span>
                  ) : (
                    <span className="text-text-tertiary">·</span>
                  )}
                </td>
              );
            })}
            <td className="py-1.5 font-bold text-text-primary">{awayScore}</td>
            <td className="py-1.5 text-text-secondary">{awayHits ?? "-"}</td>
            <td className="py-1.5 text-text-secondary">{awayErrors ?? "-"}</td>
          </tr>
          {/* Home team */}
          <tr>
            <td className="py-1.5 text-left pl-1">
              <div className="flex items-center gap-2">
                <TeamLogo team={homeTeam} size={24} />
                <span className="font-semibold text-text-primary text-base whitespace-nowrap">
                  {homeTeam.shortName}
                </span>
              </div>
            </td>
            {inningNumbers.map((n) => {
              const score = getInningScore(n, false);
              return (
                <td
                  key={n}
                  className={clsx(
                    "py-1.5",
                    n === currentInningNum && currentInning?.includes("말")
                      ? "text-accent font-bold"
                      : "text-text-primary"
                  )}
                >
                  {score !== "" ? (
                    <motion.span
                      key={`home-${n}-${score}`}
                      initial={{ scale: 1.3, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: "spring", stiffness: 300, damping: 20 }}
                    >
                      {score}
                    </motion.span>
                  ) : (
                    <span className="text-text-tertiary">·</span>
                  )}
                </td>
              );
            })}
            <td className="py-1.5 font-bold text-text-primary">{homeScore}</td>
            <td className="py-1.5 text-text-secondary">{homeHits ?? "-"}</td>
            <td className="py-1.5 text-text-secondary">{homeErrors ?? "-"}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
