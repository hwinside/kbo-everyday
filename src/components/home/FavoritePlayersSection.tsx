import Link from "next/link";
import { getTeamById } from "@/lib/constants/teams";

import PlayerAvatar from "@/components/ui/PlayerAvatar";
import SectionHeader from "@/components/ui/SectionHeader";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import type { FavoritePlayer } from "@/lib/store/favorites";

interface PlayerMockStats {
  avg: string;
  recent: string;
  trend: string;
  hr: number;
  rbi: number;
  era?: string;
  wins?: number;
}

const MOCK_TRENDS: Record<string, PlayerMockStats> = {
  p1: { avg: ".312", recent: "5경기 8타수 4안타", trend: "🔥", hr: 32, rbi: 85 },
  p4: { avg: ".334", recent: "5경기 9타수 5안타", trend: "🔥🔥", hr: 36, rbi: 100 },
  p10: { avg: ".298", recent: "5경기 7타수 2안타", trend: "📉", hr: 20, rbi: 68 },
  p2: { avg: "", recent: "최근 7이닝 1실점", trend: "🔥", hr: 0, rbi: 0, era: "2.89", wins: 17 },
  p5: { avg: "", recent: "최근 8이닝 무실점", trend: "🔥🔥", hr: 0, rbi: 0, era: "2.45", wins: 14 },
};

// Stable mock stats keyed by playerId to avoid random values on re-render
function getPlayerStats(playerId: string): PlayerMockStats {
  if (MOCK_TRENDS[playerId]) return MOCK_TRENDS[playerId];
  // Use a deterministic hash based on playerId
  let hash = 0;
  for (let i = 0; i < playerId.length; i++) {
    hash = ((hash << 5) - hash + playerId.charCodeAt(i)) | 0;
  }
  const absHash = Math.abs(hash);
  return {
    avg: (0.260 + (absHash % 60) / 1000).toFixed(3),
    recent: "5경기 활약 중",
    trend: absHash % 2 === 0 ? "🔥" : "→",
    hr: (absHash % 25) + 5,
    rbi: (absHash % 60) + 20,
  };
}

export default function FavoritePlayersSection({ favPlayers }: { favPlayers: FavoritePlayer[] }) {
  if (favPlayers.length === 0) return null;

  return (
    <div>
      <SectionHeader title="⭐ 나의 최애 선수" />
      <div className="flex gap-3 overflow-x-auto hide-scrollbar pb-2">
        {favPlayers.map((player) => {
          const team = getTeamById(player.teamId);
          const stats = getPlayerStats(player.playerId);
          const isPitcher = player.position === "투수";
          return (
            <Link key={player.playerId} href={`/community/players/${player.playerId}`}>
              <div
                className="min-w-[160px] rounded-2xl p-3 flex flex-col items-center gap-2 border border-border bg-bg-secondary"
              >
                <PlayerAvatar
                  name={player.name}
                  teamId={player.teamId}
                  photoUrl={getPlayerPhotoUrl(player.name, player.playerId)}
                  number={player.number}
                  size={56}
                />
                <div className="text-center">
                  <p className="text-[15px] leading-[22px] font-medium text-text-primary">{player.name}</p>
                  <p className="text-xs leading-[18px] text-text-tertiary">#{player.number} {player.position}</p>
                </div>
                <div className="w-full space-y-1">
                  {isPitcher ? (
                    <>
                      <div className="flex justify-between text-xs leading-[18px]">
                        <span className="text-text-tertiary">ERA</span>
                        <span className="font-semibold tabular-nums text-accent">{stats.era ?? "3.20"}</span>
                      </div>
                      <div className="flex justify-between text-xs leading-[18px]">
                        <span className="text-text-tertiary">승</span>
                        <span className="font-semibold tabular-nums text-accent">{stats.wins ?? 10}</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex justify-between text-xs leading-[18px]">
                        <span className="text-text-tertiary">타율</span>
                        <span className="font-semibold tabular-nums text-accent">{stats.avg}</span>
                      </div>
                      <div className="flex justify-between text-xs leading-[18px]">
                        <span className="text-text-tertiary">HR/RBI</span>
                        <span className="font-semibold tabular-nums text-accent">{stats.hr}/{stats.rbi}</span>
                      </div>
                    </>
                  )}
                </div>
                <div className="text-xs leading-[18px] text-text-tertiary text-center">
                  {stats.trend} {stats.recent}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
