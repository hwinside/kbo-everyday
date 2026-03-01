"use client";

import { motion } from "framer-motion";

interface StatRow {
  label: string;
  awayValue: number;
  homeValue: number;
}

interface TeamComparisonBarProps {
  stats: StatRow[];
  awayColor: string;
  homeColor: string;
  awayName: string;
  homeName: string;
}

export default function TeamComparisonBar({ stats, awayColor, homeColor, awayName, homeName }: TeamComparisonBarProps) {
  return (
    <div className="glass-card p-4">
      <h3 className="text-sm font-bold text-text-tertiary mb-4">팀 비교</h3>
      
      {/* Team names header */}
      <div className="flex justify-between mb-3">
        <span className="text-xs font-semibold" style={{ color: awayColor }}>{awayName}</span>
        <span className="text-xs font-semibold" style={{ color: homeColor }}>{homeName}</span>
      </div>

      <div className="space-y-3">
        {stats.map((stat) => {
          const total = stat.awayValue + stat.homeValue || 1;
          const awayPct = (stat.awayValue / total) * 100;
          const homePct = (stat.homeValue / total) * 100;
          const awayWins = stat.awayValue > stat.homeValue;
          const homeWins = stat.homeValue > stat.awayValue;

          return (
            <div key={stat.label}>
              <div className="flex items-center justify-between mb-1">
                <span className={`text-sm tabular-nums font-bold ${awayWins ? "text-text-primary" : "text-text-tertiary"}`}>
                  {stat.awayValue}
                </span>
                <span className="text-xs text-text-tertiary">{stat.label}</span>
                <span className={`text-sm tabular-nums font-bold ${homeWins ? "text-text-primary" : "text-text-tertiary"}`}>
                  {stat.homeValue}
                </span>
              </div>
              <div className="flex gap-1 h-1.5">
                <motion.div
                  initial={{ width: "50%" }}
                  animate={{ width: `${awayPct}%` }}
                  transition={{ duration: 0.8, ease: "easeOut" }}
                  className="rounded-l-full"
                  style={{ backgroundColor: awayWins ? awayColor : `${awayColor}40` }}
                />
                <motion.div
                  initial={{ width: "50%" }}
                  animate={{ width: `${homePct}%` }}
                  transition={{ duration: 0.8, ease: "easeOut" }}
                  className="rounded-r-full"
                  style={{ backgroundColor: homeWins ? homeColor : `${homeColor}40` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
