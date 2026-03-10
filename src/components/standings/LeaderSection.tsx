"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { TEAMS } from "@/lib/constants/teams";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { hexToRgba, getTeamColor } from "@/lib/utils/standings";
import type { TitleLeader } from "@/lib/constants/standings-data";

interface LeaderSectionProps {
  title: string;
  leaders: TitleLeader[];
  myTeamId: number | null;
  favoriteNames: Set<string>;
}

export default function LeaderSection({ title, leaders, myTeamId, favoriteNames }: LeaderSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const router = useRouter();
  const shown = expanded ? leaders : leaders.slice(0, 5);

  return (
    <div className="glass-card p-4">
      <h3 className="text-base font-semibold text-text-tertiary mb-3">{title}</h3>
      <div className="space-y-3">
        {shown.map((l) => {
          const isMyTeam = myTeamId != null && l.teamId === myTeamId;
          const isFavorite = favoriteNames.has(l.name);
          const hlLevel = isFavorite ? 2 : isMyTeam ? 1 : 0;
          const teamColor = TEAMS.find((t) => t.id === l.teamId)?.colorPrimary || "#FF6B35";

          return (
          <div
            key={l.rank}
            onClick={() => l.playerId && router.push(`/community/players/${l.playerId}`)}
            className="flex items-center gap-3 cursor-pointer hover:bg-white/5 rounded-lg transition-colors py-1 px-1"
            style={hlLevel === 0 ? undefined : {
              borderLeft: `${hlLevel === 2 ? 4 : 3}px solid ${hexToRgba(teamColor, hlLevel === 2 ? 1 : 0.8)}`,
              backgroundColor: hexToRgba(teamColor, hlLevel === 2 ? 0.18 : 0.12),
              borderRadius: 8,
              paddingLeft: 8,
            }}
          >
            <span className={clsx("flex h-6 w-6 items-center justify-center rounded-full text-base font-bold",
              l.rank === 1 ? "bg-yellow-500/20 text-yellow-400" :
              l.rank === 2 ? "bg-gray-400/20 text-gray-300" :
              l.rank === 3 ? "bg-amber-700/20 text-amber-600" :
              "bg-bg-tertiary text-text-tertiary"
            )}>
              {l.rank}
            </span>
            <PlayerAvatar name={l.name} teamId={l.teamId} photoUrl={getPlayerPhotoUrl(l.name, l.playerId)} size={52} />
            <span className="flex-1 text-base text-text-primary">
              {l.name}
              {isFavorite && <span className="ml-1">★</span>}
            </span>
            <span className="text-base font-bold tabular-nums" style={{ color: getTeamColor(l.teamId) }}>{l.value}</span>
          </div>
          );
        })}
      </div>
      {leaders.length > 5 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full mt-3 pt-2 border-t border-border text-sm text-accent font-medium"
        >
          {expanded ? "접기 ▲" : `더보기 (${leaders.length}위까지) ▼`}
        </button>
      )}
    </div>
  );
}
