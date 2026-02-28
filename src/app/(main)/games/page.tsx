"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import GlassCard from "@/components/ui/GlassCard";
import TeamLogo from "@/components/ui/TeamLogo";
import { getTeamById } from "@/lib/constants/teams";
import { MOCK_GAMES } from "@/lib/constants/games";

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
};

const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0 },
};

export default function GamesPage() {
  return (
    <div className="mx-auto max-w-lg px-5">
      <header className="py-5">
        <h1 className="text-lg font-bold text-text-primary">오늘의 경기</h1>
        <p className="text-base text-text-secondary">2026년 3월 28일 토요일</p>
      </header>

      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="space-y-4 pb-5"
      >
        {MOCK_GAMES.map((game) => {
          const home = getTeamById(game.homeTeamId)!;
          const away = getTeamById(game.awayTeamId)!;
          return (
            <motion.div key={game.id} variants={item}>
              <Link href={`/games/${game.id}`}>
                <GlassCard pressable className="p-5">
                  {/* Status */}
                  <div className="flex items-center justify-between mb-4">
                    {game.status === "live" ? (
                      <span className="flex items-center gap-1.5">
                        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent/15 text-base font-bold text-accent">
                          <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
                          LIVE
                        </span>
                        <span className="text-base text-accent-green font-medium">
                          {game.inning}
                        </span>
                      </span>
                    ) : game.status === "final" ? (
                      <span className="text-base text-text-secondary font-medium">경기 종료</span>
                    ) : (
                      <span className="text-base text-text-secondary">{game.time} 예정</span>
                    )}
                    <span className="text-base text-text-tertiary">{game.stadium}</span>
                  </div>

                  {/* Teams and scores */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <TeamLogo
                        team={away}
                        size={64}
                        className="shadow-md"
                        style={game.status === "live" ? { boxShadow: `0 0 12px ${away.colorPrimary}40` } : undefined}
                      />
                      <span className="text-base font-semibold text-text-primary">{away.shortName}</span>
                    </div>
                    <div className="flex items-center gap-4 text-2xl font-bold tabular-nums">
                      {game.status === "scheduled" ? (
                        <span className="text-base text-text-tertiary">VS</span>
                      ) : (
                        <>
                          <span className="text-text-primary">{game.awayScore}</span>
                          <span className="text-base text-text-tertiary">:</span>
                          <span className="text-text-primary">{game.homeScore}</span>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-base font-semibold text-text-primary">{home.shortName}</span>
                      <TeamLogo
                        team={home}
                        size={64}
                        className="shadow-md"
                        style={game.status === "live" ? { boxShadow: `0 0 12px ${home.colorPrimary}40` } : undefined}
                      />
                    </div>
                  </div>
                </GlassCard>
              </Link>
            </motion.div>
          );
        })}
      </motion.div>
    </div>
  );
}
