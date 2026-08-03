"use client";

import { motion } from "framer-motion";
import type { TeamStanding } from "@/lib/types";
import { gameResultTone, resultToneChipStyle } from "@/lib/ui/result-tone";

interface TeamDashboardProps {
  standing: TeamStanding;
  teamColor: string;
  teamName: string;
}

const LEAGUE_AVG = {
  avg: 0.267,
  ops: 0.735,
  era: 4.25,
  whip: 1.35,
};

// LG 트윈스 팀 스탯 목업
const TEAM_STATS = {
  1: { avg: 0.282, ops: 0.778, era: 3.58, whip: 1.21 },
} as Record<number, { avg: number; ops: number; era: number; whip: number }>;

const RECENT_10 = [
  { result: "W", score: "5-3" },
  { result: "W", score: "7-2" },
  { result: "L", score: "1-4" },
  { result: "W", score: "3-1" },
  { result: "W", score: "6-5" },
  { result: "L", score: "2-8" },
  { result: "W", score: "4-3" },
  { result: "L", score: "3-5" },
  { result: "W", score: "9-2" },
  { result: "W", score: "5-4" },
];

const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
};

export default function TeamDashboard({
  standing,
  teamColor,
}: TeamDashboardProps) {
  const teamStats = TEAM_STATS[standing.teamId] ?? LEAGUE_AVG;

  return (
    <div className="space-y-5">
      {/* Record */}
      <motion.div variants={item} className="glass-card p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-text-secondary">2026 시즌</h3>
            <p className="mt-1 text-2xl font-bold text-text-primary">
              {standing.rank}위
            </p>
          </div>
          <div className="text-right">
            <p className="text-lg font-bold tabular-nums text-text-primary">
              {standing.wins}승 {standing.losses}패 {standing.draws}무
            </p>
            <p className="text-base tabular-nums text-text-secondary">
              승률 {standing.pct.toFixed(3).slice(1)} · {standing.streak}
            </p>
          </div>
        </div>
      </motion.div>

      {/* Team vs League */}
      <motion.div variants={item} className="glass-card p-5">
        <h3 className="mb-4 text-base font-semibold text-text-secondary">팀 vs 리그 평균</h3>
        <div className="space-y-4">
          <CompareBar
            label="타율"
            team={teamStats.avg}
            league={LEAGUE_AVG.avg}
            format={(v) => v.toFixed(3).slice(1)}
            teamColor={teamColor}
          />
          <CompareBar
            label="OPS"
            team={teamStats.ops}
            league={LEAGUE_AVG.ops}
            format={(v) => v.toFixed(3).slice(1)}
            teamColor={teamColor}
          />
          <CompareBar
            label="ERA"
            team={teamStats.era}
            league={LEAGUE_AVG.era}
            format={(v) => v.toFixed(2)}
            teamColor={teamColor}
            lowerIsBetter
          />
          <CompareBar
            label="WHIP"
            team={teamStats.whip}
            league={LEAGUE_AVG.whip}
            format={(v) => v.toFixed(2)}
            teamColor={teamColor}
            lowerIsBetter
          />
        </div>
      </motion.div>

      {/* Recent 10 Games */}
      <motion.div variants={item} className="glass-card p-5">
        <h3 className="mb-4 text-base font-semibold text-text-secondary">최근 10경기</h3>
        <div className="flex gap-2">
          {RECENT_10.map((game, i) => (
            <div
              key={i}
              className="flex flex-1 flex-col items-center gap-1 rounded-lg py-2"
              // 승패 색은 홈 팀카드 기준 SSOT(@/lib/ui/result-tone). 이전엔 승=teamColor·패=회색이라
              // 팀마다 승색이 달라지고 패는 중립과 구별이 안 됐다(삼순 3차 지적).
              style={{
                backgroundColor: resultToneChipStyle(
                  gameResultTone(game.result as "W" | "L" | "D"),
                ).backgroundColor,
              }}
            >
              <span
                className="text-base font-bold"
                style={{
                  color: resultToneChipStyle(
                    gameResultTone(game.result as "W" | "L" | "D"),
                  ).color,
                }}
              >
                {game.result}
              </span>
              <span className="text-base tabular-nums text-text-tertiary">{game.score}</span>
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  );
}

function CompareBar({
  label,
  team,
  league,
  format,
  teamColor,
  lowerIsBetter,
}: {
  label: string;
  team: number;
  league: number;
  format: (v: number) => string;
  teamColor: string;
  lowerIsBetter?: boolean;
}) {
  const isBetter = lowerIsBetter ? team < league : team > league;
  const ratio = lowerIsBetter
    ? Math.min((league / team) * 50, 95)
    : Math.min((team / league) * 50, 95);

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-base">
        <span className="text-text-secondary">{label}</span>
        <div className="flex items-center gap-3">
          <span className="font-bold text-text-primary" style={{ color: isBetter ? teamColor : undefined }}>
            {format(team)}
          </span>
          <span className="text-text-tertiary">vs {format(league)}</span>
        </div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-bg-tertiary">
        <motion.div
          className="h-full rounded-full"
          style={{ backgroundColor: teamColor }}
          initial={{ width: 0 }}
          animate={{ width: `${ratio}%` }}
          transition={{ duration: 0.6, ease: "easeOut" }}
        />
      </div>
    </div>
  );
}
