"use client";

import { motion } from "framer-motion";
import { TEAMS } from "@/lib/constants/teams";
import type { TeamStanding } from "@/lib/types";

const MOCK_STANDINGS: TeamStanding[] = [
  { teamId: 1, season: 2026, rank: 1, wins: 85, losses: 56, draws: 3, pct: 0.603, gb: 0, streak: "3연승", last10: "7승3패" },
  { teamId: 9, season: 2026, rank: 2, wins: 83, losses: 57, draws: 4, pct: 0.593, gb: 1.5, streak: "2연승", last10: "6승4패" },
  { teamId: 4, season: 2026, rank: 3, wins: 75, losses: 64, draws: 5, pct: 0.536, gb: 9.5, streak: "1연패", last10: "5승5패" },
  { teamId: 6, season: 2026, rank: 4, wins: 73, losses: 67, draws: 4, pct: 0.521, gb: 12, streak: "1연승", last10: "6승4패" },
  { teamId: 5, season: 2026, rank: 5, wins: 71, losses: 69, draws: 4, pct: 0.507, gb: 14, streak: "2연패", last10: "4승6패" },
  { teamId: 2, season: 2026, rank: 6, wins: 70, losses: 70, draws: 4, pct: 0.500, gb: 15, streak: "1연승", last10: "5승5패" },
  { teamId: 8, season: 2026, rank: 7, wins: 67, losses: 73, draws: 4, pct: 0.479, gb: 18, streak: "3연패", last10: "3승7패" },
  { teamId: 3, season: 2026, rank: 8, wins: 65, losses: 75, draws: 4, pct: 0.464, gb: 20, streak: "1연패", last10: "4승6패" },
  { teamId: 7, season: 2026, rank: 9, wins: 60, losses: 80, draws: 4, pct: 0.429, gb: 25, streak: "2연승", last10: "5승5패" },
  { teamId: 10, season: 2026, rank: 10, wins: 55, losses: 85, draws: 4, pct: 0.393, gb: 30, streak: "4연패", last10: "2승8패" },
];

function getTeam(id: number) {
  return TEAMS.find((t) => t.id === id)!;
}

function getStreakIcon(streak: string) {
  const num = parseInt(streak);
  if (streak.includes("연승") && num >= 3) return "🔥";
  if (streak.includes("연패") && num >= 3) return "❄️";
  return "";
}

export default function StandingsPage() {
  return (
    <div className="mx-auto max-w-lg px-4">
      <header className="py-4">
        <h1 className="text-lg font-bold text-text-primary">순위표</h1>
        <p className="text-xs text-text-secondary">2026 시즌</p>
      </header>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass-card overflow-hidden"
      >
        {/* Table */}
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-[11px] font-semibold text-text-tertiary">
              <th className="w-8 py-2 text-center">#</th>
              <th className="py-2 text-left pl-2">팀</th>
              <th className="w-9 py-2 text-center">승</th>
              <th className="w-9 py-2 text-center">패</th>
              <th className="w-9 py-2 text-center">무</th>
              <th className="w-12 py-2 text-center">승률</th>
              <th className="w-9 py-2 text-center">차</th>
            </tr>
          </thead>
          <tbody>
            {MOCK_STANDINGS.map((standing, i) => {
              const team = getTeam(standing.teamId);
              const isMyTeam = standing.teamId === 1; // LG
              return (
                <motion.tr
                  key={standing.teamId}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.03 }}
                  className={`border-b border-border/30 last:border-0 ${isMyTeam ? "bg-white/5" : ""}`}
                >
                  <td className="py-2.5 text-center font-bold text-text-primary">
                    {standing.rank}
                  </td>
                  <td className="py-2.5 pl-2">
                    <div className="flex items-center gap-1.5">
                      <div
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
                        style={{ backgroundColor: team.colorPrimary }}
                      >
                        {team.shortName.charAt(0)}
                      </div>
                      <span className="font-medium text-text-primary whitespace-nowrap">
                        {team.shortName}
                      </span>
                      {getStreakIcon(standing.streak) && (
                        <span className="text-xs">{getStreakIcon(standing.streak)}</span>
                      )}
                    </div>
                  </td>
                  <td className="py-2.5 text-center tabular-nums text-text-primary">{standing.wins}</td>
                  <td className="py-2.5 text-center tabular-nums text-text-primary">{standing.losses}</td>
                  <td className="py-2.5 text-center tabular-nums text-text-secondary">{standing.draws}</td>
                  <td className="py-2.5 text-center tabular-nums font-semibold text-text-primary">
                    {standing.pct.toFixed(3).slice(1)}
                  </td>
                  <td className="py-2.5 text-center tabular-nums text-text-secondary">
                    {standing.gb === 0 ? "-" : standing.gb}
                  </td>
                </motion.tr>
              );
            })}
          </tbody>
        </table>
      </motion.div>
    </div>
  );
}
