"use client";

import { motion } from "framer-motion";
import { Radio } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLiveGame, type LiveGameData } from "@/lib/hooks/useLiveGame";
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

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {away && <TeamLogo team={away} size={28} />}
          <span className="text-sm font-bold text-text-primary">{game.awayName}</span>
        </div>
        <span className="text-2xl font-black tabular-nums" style={{ color: awayColor }}>{game.awayScore}</span>
      </div>
      <div className="flex items-center justify-between mt-2">
        <div className="flex items-center gap-2">
          {home && <TeamLogo team={home} size={28} />}
          <span className="text-sm font-bold text-text-primary">{game.homeName}</span>
        </div>
        <span className="text-2xl font-black tabular-nums" style={{ color: homeColor }}>{game.homeScore}</span>
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

export default function LiveGameBanner() {
  const { liveGames, loading } = useLiveGame(undefined, 30000);
  if (loading || liveGames.length === 0) return null;

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 px-5 mb-3">
        <Radio size={16} className="text-red-400" />
        <h2 className="text-base font-bold text-text-primary">실시간 경기</h2>
        <span className="text-xs text-text-tertiary">{liveGames.length}경기 진행 중</span>
      </div>
      <div className="flex gap-3 overflow-x-auto hide-scrollbar px-5">
        {liveGames.map(game => (
          <LiveGameCard key={game.gameId} game={game} />
        ))}
      </div>
    </div>
  );
}
