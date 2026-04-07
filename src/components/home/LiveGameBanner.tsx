"use client";

import { motion } from "framer-motion";
import { Radio } from "lucide-react";
import { useRouter } from "next/navigation";
import type { LiveGameData } from "@/lib/hooks/useLiveGame";
import Diamond from "@/components/game/Diamond";
import { TEAMS } from "@/lib/constants/teams";
import TeamLogo from "@/components/ui/TeamLogo";

function teamByName(name: string) {
  return TEAMS.find(t => t.name.includes(name) || t.shortName === name || name.includes(t.shortName));
}

function LiveGameCard({ game }: { game: LiveGameData }) {
  const router = useRouter();
  const away = teamByName(game.awayName);
  const home = teamByName(game.homeName);
  const awayColor = away?.colorLight || away?.colorPrimary || "#888";
  const homeColor = home?.colorLight || home?.colorPrimary || "#888";

  return (
    <motion.div
      className="flex-shrink-0 w-[300px] rounded-2xl bg-gradient-to-br from-bg-secondary to-bg-tertiary border border-border p-4 cursor-pointer"
      whileTap={{ scale: 0.97 }}
      onClick={() => game.gameId && router.push("/games/" + game.gameId)}
    >
      <div className="flex items-center gap-2 mb-3">
        <motion.div className="w-2 h-2 rounded-full bg-red-500" animate={{ opacity: [1, 0.3, 1] }} transition={{ repeat: Infinity, duration: 1.5 }} />
        <span className="text-xs font-bold text-red-400">LIVE</span>
        <span className="text-xs text-accent font-bold">{game.currentInning}</span>
        {game.stadium && <span className="text-xs text-text-tertiary ml-auto">{game.stadium}</span>}
      </div>

      {/* Horizontal layout: away left, score center, home right */}
      <div className="flex items-center justify-between">
        <div className="flex flex-col items-center gap-1 flex-1">
          {away && <TeamLogo team={away} size={28} />}
          <span className="text-base font-bold" style={{ color: awayColor }}>{game.awayName}</span>
        </div>
        <div className="flex items-center gap-3 px-2">
          <span className="text-2xl font-black tabular-nums text-text-primary">{game.awayScore}</span>
          <span className="text-sm text-text-tertiary">:</span>
          <span className="text-2xl font-black tabular-nums text-text-primary">{game.homeScore}</span>
        </div>
        <div className="flex flex-col items-center gap-1 flex-1">
          {home && <TeamLogo team={home} size={28} />}
          <span className="text-base font-bold" style={{ color: homeColor }}>{game.homeName}</span>
        </div>
      </div>

      <div className="flex items-center justify-between mt-3 pt-3 border-t border-border">
        <div className="flex items-center gap-3 text-[11px] font-mono">
          <span>B <span className="text-green-400">{"●".repeat(game.balls)}{"○".repeat(4 - game.balls)}</span></span>
          <span>S <span className="text-yellow-400">{"●".repeat(game.strikes)}{"○".repeat(3 - game.strikes)}</span></span>
          <span>O <span className="text-red-400">{"●".repeat(game.outs)}{"○".repeat(3 - game.outs)}</span></span>
        </div>
        <Diamond runner1b={game.runner1b} runner2b={game.runner2b} runner3b={game.runner3b} teamColor={game.isTop ? awayColor : homeColor} />
      </div>

      {(game.currentBatter || game.currentPitcher) && (
        <div className="mt-2 text-xs text-text-tertiary truncate">
          {game.currentPitcher && <span>P {game.currentPitcher}</span>}
          {game.currentBatter && <span className="ml-3">AB {game.currentBatter}</span>}
        </div>
      )}
    </motion.div>
  );
}

export default function LiveGameBanner({ excludeGameId, liveGames }: { excludeGameId?: string; liveGames: LiveGameData[] }) {
  const filteredGames = excludeGameId ? liveGames.filter(g => g.gameId !== excludeGameId) : liveGames;
  if (filteredGames.length === 0) return null;

  return (
    <div className="mb-4">
      <div className="mb-3 flex items-center justify-between px-5">
        <h2 className="flex items-center gap-2 text-lg leading-[26px] font-semibold text-text-primary">
          <Radio size={18} className="text-red-400" /> 실시간 경기
        </h2>
        <span className="text-xs text-text-tertiary">{filteredGames.length}경기 진행 중</span>
      </div>
      <div className="flex gap-3 overflow-x-auto hide-scrollbar px-5">
        {filteredGames.map(game => (
          <LiveGameCard key={game.gameId} game={game} />
        ))}
      </div>
    </div>
  );
}
