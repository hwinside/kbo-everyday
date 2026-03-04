"use client";

import Image from "next/image";
import Link from "next/link";
import { getTeamById } from "@/lib/constants/teams";

interface CompactGameCardProps {
  game: {
    id: string;
    awayTeamId: number;
    homeTeamId: number;
    awayScore: number | null;
    homeScore: number | null;
    status: "scheduled" | "live" | "final";
    inning?: string;
    time: string;
    stadium: string;
  };
}

export default function CompactGameCard({ game }: CompactGameCardProps) {
  const away = getTeamById(game.awayTeamId)!;
  const home = getTeamById(game.homeTeamId)!;
  const isLive = game.status === "live";
  const isFinal = game.status === "final";
  const awayWin = isFinal && (game.awayScore ?? 0) > (game.homeScore ?? 0);
  const homeWin = isFinal && (game.homeScore ?? 0) > (game.awayScore ?? 0);

  return (
    <Link href={`/games/${game.id}`}>
      <div className="glass-card p-4 hover:bg-white/5 transition-colors">
        {/* Status */}
        <div className="flex items-center justify-between mb-3">
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
            isLive ? "bg-red-500/20 text-red-400 animate-pulse" :
            isFinal ? "bg-text-tertiary/20 text-text-tertiary" :
            "bg-accent/20 text-accent"
          }`}>
            {isLive ? `LIVE ${game.inning}` : isFinal ? "종료" : game.time}
          </span>
          <div className="flex items-center gap-2">{game.id.startsWith("pre-") && (<span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-500">시범경기</span>)}<span className="text-xs text-text-tertiary">{game.stadium}</span></div>
        </div>

        {/* Away team row */}
        <div className={`flex items-center justify-between py-1.5 ${awayWin ? "" : isFinal ? "opacity-50" : ""}`}>
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-full bg-white p-0.5 flex items-center justify-center">
              <Image src={away.logoPath} alt="" width={20} height={20} unoptimized className="object-contain" />
            </div>
            <span className={`text-sm font-semibold ${awayWin ? "text-text-primary" : "text-text-secondary"}`}>
              {away.shortName}
            </span>
          </div>
          <span className={`text-lg font-bold tabular-nums ${awayWin ? "text-text-primary" : "text-text-secondary"}`}>
            {game.status === "scheduled" ? "-" : game.awayScore}
          </span>
        </div>

        {/* Home team row */}
        <div className={`flex items-center justify-between py-1.5 ${homeWin ? "" : isFinal ? "opacity-50" : ""}`}>
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-full bg-white p-0.5 flex items-center justify-center">
              <Image src={home.logoPath} alt="" width={20} height={20} unoptimized className="object-contain" />
            </div>
            <span className={`text-sm font-semibold ${homeWin ? "text-text-primary" : "text-text-secondary"}`}>
              {home.shortName}
            </span>
          </div>
          <span className={`text-lg font-bold tabular-nums ${homeWin ? "text-text-primary" : "text-text-secondary"}`}>
            {game.status === "scheduled" ? "-" : game.homeScore}
          </span>
        </div>
      </div>
    </Link>
  );
}
