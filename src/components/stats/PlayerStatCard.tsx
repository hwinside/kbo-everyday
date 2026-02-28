"use client";

import { motion } from "framer-motion";
import type { PlayerSeasonStats } from "@/lib/types";
import { POSITION_LABELS, getSeasonHighlights } from "@/lib/constants/players";
import { getTeamById } from "@/lib/constants/teams";
import RadarChart from "./RadarChart";
import TrendChart from "./TrendChart";
import type { PlayerGameLog, PitcherGameLog } from "@/lib/constants/players";

interface PlayerStatCardProps {
  player: {
    id: number;
    name: string;
    number: number;
    position: string;
    teamId: number;
  };
  stats: PlayerSeasonStats;
  gameLog: PlayerGameLog[] | PitcherGameLog[] | null;
  teamColor: string;
  teamName: string;
}

const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
};

export default function PlayerStatCard({
  player,
  stats,
  gameLog,
  teamColor,
  teamName,
}: PlayerStatCardProps) {
  const isPitcher = ["SP", "RP", "CP"].includes(player.position);
  const highlights = getSeasonHighlights(player.id);

  return (
    <div className="space-y-4">
      {/* Profile Header */}
      <motion.div variants={item} className="glass-card p-4">
        <div className="flex items-center gap-4">
          <div
            className="flex h-16 w-16 items-center justify-center rounded-2xl text-xl font-bold text-white"
            style={{
              background: `linear-gradient(135deg, ${teamColor}, ${getTeamById(player.teamId)?.colorSecondary ?? teamColor})`,
            }}
          >
            {player.number}
          </div>
          <div>
            <h2 className="text-xl font-bold text-text-primary">{player.name}</h2>
            <p className="text-sm text-text-secondary">
              {teamName} · {POSITION_LABELS[player.position] ?? player.position}
            </p>
          </div>
        </div>
      </motion.div>

      {/* Key Numbers */}
      <motion.div variants={item} className="glass-card p-4">
        <h3 className="mb-3 text-sm font-semibold text-text-secondary">핵심 스탯</h3>
        <div className="grid grid-cols-3 gap-3">
          {isPitcher ? (
            <>
              <StatNumber label="ERA" value={stats.era?.toFixed(2) ?? "-"} />
              <StatNumber label="WHIP" value={stats.whip?.toFixed(2) ?? "-"} />
              <StatNumber label="K/9" value={stats.kPer9?.toFixed(1) ?? "-"} />
              <StatNumber label="승" value={String(stats.wins ?? 0)} />
              <StatNumber label="패" value={String(stats.losses ?? 0)} />
              <StatNumber label="이닝" value={stats.ip?.toFixed(1) ?? "-"} />
            </>
          ) : (
            <>
              <StatNumber label="타율" value={stats.avg?.toFixed(3).slice(1) ?? "-"} highlight />
              <StatNumber label="HR" value={String(stats.hr ?? 0)} />
              <StatNumber label="타점" value={String(stats.rbi ?? 0)} />
              <StatNumber label="OPS" value={stats.ops?.toFixed(3).slice(1) ?? "-"} />
              <StatNumber label="도루" value={String(stats.sb ?? 0)} />
              <StatNumber label="안타" value={String(stats.hits ?? 0)} />
            </>
          )}
        </div>
      </motion.div>

      {/* Radar Chart */}
      <motion.div variants={item} className="glass-card p-4">
        <h3 className="mb-1 text-sm font-semibold text-text-secondary">
          리그 평균 대비 {isPitcher ? "투구" : "타격"} 능력
        </h3>
        <RadarChart stats={stats} teamColor={teamColor} isPitcher={isPitcher} />
      </motion.div>

      {/* Trend Chart */}
      {gameLog && (
        <motion.div variants={item} className="glass-card p-4">
          <h3 className="mb-3 text-sm font-semibold text-text-secondary">
            최근 10경기 {isPitcher ? "ERA" : "타율"} 추이
          </h3>
          <TrendChart data={gameLog} teamColor={teamColor} isPitcher={isPitcher} />
        </motion.div>
      )}

      {/* Season Highlights */}
      {highlights.length > 0 && (
        <motion.div variants={item} className="glass-card p-4">
          <h3 className="mb-3 text-sm font-semibold text-text-secondary">시즌 하이라이트</h3>
          <div className="space-y-2">
            {highlights.map((h, i) => (
              <div
                key={i}
                className="flex items-center gap-3 rounded-xl bg-bg-tertiary/50 px-3 py-2.5"
              >
                <span className="text-lg text-accent-gold">🏆</span>
                <div className="flex-1">
                  <p className="text-sm font-medium text-text-primary">{h.label}</p>
                  <p className="text-xs text-text-tertiary">{h.date}</p>
                </div>
                <span className="text-sm font-bold text-accent-gold">{h.value}</span>
              </div>
            ))}
          </div>
        </motion.div>
      )}
    </div>
  );
}

function StatNumber({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="text-center">
      <p className="text-[11px] font-medium text-text-tertiary">{label}</p>
      <p
        className={`mt-0.5 text-2xl font-bold tabular-nums ${
          highlight ? "text-text-primary" : "text-text-primary"
        }`}
        style={{ fontFamily: "SF Mono, ui-monospace, monospace" }}
      >
        {value}
      </p>
    </div>
  );
}
