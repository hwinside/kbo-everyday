"use client";

import { motion } from "framer-motion";
import GlassCard from "@/components/ui/GlassCard";
import TeamBadge from "@/components/ui/TeamBadge";
import LevelBadge from "@/components/ui/LevelBadge";
import type { LeaderboardEntry } from "@/lib/constants/predictions";

interface LeaderboardProps {
  entries: LeaderboardEntry[];
}

const MEDAL_STYLES: Record<number, { bg: string; border: string; text: string }> = {
  1: { bg: "from-yellow-500/20 to-yellow-600/5", border: "border-yellow-500/30", text: "text-yellow-400" },
  2: { bg: "from-gray-300/15 to-gray-400/5", border: "border-gray-400/30", text: "text-gray-300" },
  3: { bg: "from-orange-700/15 to-orange-800/5", border: "border-orange-600/30", text: "text-orange-400" },
};

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) return <span className="text-lg">🥇</span>;
  if (rank === 2) return <span className="text-lg">🥈</span>;
  if (rank === 3) return <span className="text-lg">🥉</span>;
  return (
    <span className="flex h-7 w-7 items-center justify-center text-sm font-bold tabular-nums text-text-secondary">
      {rank}
    </span>
  );
}

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.03 } },
};

const item = {
  hidden: { opacity: 0, x: -8 },
  show: { opacity: 1, x: 0, transition: { duration: 0.2 } },
};

export default function Leaderboard({ entries }: LeaderboardProps) {
  const myEntry = entries.find((e) => e.isMe);

  return (
    <div className="relative">
      {/* Top 3 podium */}
      <div className="mb-4 grid grid-cols-3 gap-2">
        {entries.slice(0, 3).map((entry) => {
          const style = MEDAL_STYLES[entry.rank];
          return (
            <motion.div
              key={entry.userId}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: (entry.rank - 1) * 0.15, duration: 0.4 }}
              className={`glass-card overflow-hidden border ${style.border} p-3 text-center ${
                entry.rank === 1 ? "order-2" : entry.rank === 2 ? "order-1" : "order-3"
              }`}
            >
              <div className={`absolute inset-0 bg-gradient-to-b ${style.bg}`} />
              <div className="relative">
                <RankBadge rank={entry.rank} />
                <p className={`mt-1 text-sm font-bold ${style.text}`}>
                  {entry.nickname}
                </p>
                <TeamBadge teamId={entry.teamId} className="mt-1" />
                <p className="mt-2 text-lg font-bold tabular-nums text-text-primary">
                  {entry.points.toLocaleString()}
                  <span className="text-xs text-text-tertiary">p</span>
                </p>
                <p className="text-[11px] text-text-secondary">
                  적중률 {Math.round((entry.totalCorrect / entry.totalPredictions) * 100)}%
                </p>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Rest of list */}
      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="space-y-1.5"
      >
        {entries.slice(3).map((entry) => (
          <motion.div
            key={entry.userId}
            variants={item}
            className={`flex items-center gap-3 rounded-xl px-3 py-2.5 ${
              entry.isMe
                ? "bg-accent/10 ring-1 ring-accent/20"
                : "bg-bg-glass"
            }`}
          >
            <RankBadge rank={entry.rank} />

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <TeamBadge teamId={entry.teamId} />
                <span
                  className={`truncate text-sm font-semibold ${
                    entry.isMe ? "text-accent" : "text-text-primary"
                  }`}
                >
                  {entry.nickname}
                </span>
                <LevelBadge level={entry.level} />
              </div>
            </div>

            <div className="text-right flex-shrink-0">
              <p className="text-sm font-bold tabular-nums text-text-primary">
                {entry.points.toLocaleString()}p
              </p>
              <p className="text-[11px] text-text-tertiary">
                {Math.round((entry.totalCorrect / entry.totalPredictions) * 100)}%
                {entry.currentStreak > 0 && (
                  <span className="ml-1 text-orange-400">🔥{entry.currentStreak}</span>
                )}
              </p>
            </div>
          </motion.div>
        ))}
      </motion.div>

      {/* My rank sticky footer */}
      {myEntry && (
        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="sticky bottom-20 mt-4"
        >
          <div className="glass-card flex items-center gap-3 border border-accent/20 bg-accent/5 p-3">
            <RankBadge rank={myEntry.rank} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <TeamBadge teamId={myEntry.teamId} />
                <span className="truncate text-sm font-bold text-accent">
                  {myEntry.nickname} (나)
                </span>
                <LevelBadge level={myEntry.level} />
              </div>
            </div>
            <div className="text-right flex-shrink-0">
              <p className="text-sm font-bold tabular-nums text-text-primary">
                {myEntry.points.toLocaleString()}p
              </p>
              <p className="text-[11px] text-text-tertiary">
                적중률 {Math.round((myEntry.totalCorrect / myEntry.totalPredictions) * 100)}%
              </p>
            </div>
          </div>
        </motion.div>
      )}
    </div>
  );
}
