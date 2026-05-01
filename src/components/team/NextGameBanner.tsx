"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import TeamLogo from "@/components/ui/TeamLogo";
import { getTeamById, getTeamBgColor, type TeamData } from "@/lib/constants/teams";

interface NextGame {
  gameId: string;
  date: string;
  time: string;
  opponentId: number;
  home: boolean;
  stadium: string;
  starterName?: string;
}

interface NextGameBannerProps {
  team: TeamData;
}

export default function NextGameBanner({ team }: NextGameBannerProps) {
  const [game, setGame] = useState<NextGame | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function findNextGame() {
      const today = new Date();
      for (let i = 0; i < 7; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() + i);
        const dateStr = d.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }).replace(/-/g, "");
        try {
          const res = await fetch(`/api/games?date=${dateStr}`);
          if (!res.ok) continue;
          const data = await res.json();
          const games = data.games || data;
          const match = (Array.isArray(games) ? games : []).find(
            (g: { awayTeamId: number; homeTeamId: number; status: string }) =>
              (g.awayTeamId === team.id || g.homeTeamId === team.id) &&
              g.status !== "cancelled"
          );
          if (match) {
            const isHome = match.homeTeamId === team.id;
            setGame({
              gameId: match.gameId,
              date: match.date,
              time: match.time,
              opponentId: isHome ? match.awayTeamId : match.homeTeamId,
              home: isHome,
              stadium: match.stadium,
              starterName: isHome ? match.homeStarterName : match.awayStarterName,
            });
            break;
          }
        } catch { /* skip */ }
      }
      setLoading(false);
    }
    findNextGame();
  }, [team.id]);

  if (loading || !game) return null;

  const opponent = getTeamById(game.opponentId);
  if (!opponent) return null;

  const dateObj = new Date(
    parseInt(game.date.slice(0, 4)),
    parseInt(game.date.slice(4, 6)) - 1,
    parseInt(game.date.slice(6, 8))
  );
  const dayLabel = dateObj.toLocaleDateString("ko-KR", { month: "short", day: "numeric", weekday: "short" });

  return (
    <Link href={`/games/${game.gameId}`}>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="mx-5 mb-4 rounded-2xl p-4 flex items-center gap-4"
        style={{ backgroundColor: `${getTeamBgColor(team)}15` }}
      >
        <div className="flex-1 min-w-0">
          <p className="text-xs text-text-tertiary mb-1">다음 경기</p>
          <p className="text-sm font-bold text-text-primary">
            {game.home ? "vs" : "@"} {opponent.shortName}
          </p>
          <p className="text-xs text-text-secondary mt-0.5">
            {dayLabel} {game.time} · {game.stadium}
          </p>
          {game.starterName && (
            <p className="text-xs text-text-tertiary mt-0.5">선발 {game.starterName}</p>
          )}
        </div>
        <TeamLogo team={opponent} size={40} />
      </motion.div>
    </Link>
  );
}
