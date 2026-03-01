"use client";

import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";

interface DecisionPitcher {
  name: string;
  teamId: number;
  role: "WIN" | "LOSS" | "SAVE";
  record: string; // e.g. "10-3"
  era: string;
}

interface GameDecisionPitchersProps {
  pitchers: DecisionPitcher[];
}

const ROLE_STYLE = {
  WIN: { label: "승", bg: "bg-green-500/20", text: "text-green-400" },
  LOSS: { label: "패", bg: "bg-red-500/20", text: "text-red-400" },
  SAVE: { label: "세", bg: "bg-blue-500/20", text: "text-blue-400" },
};

export default function GameDecisionPitchers({ pitchers }: GameDecisionPitchersProps) {
  return (
    <div className="glass-card p-4">
      <h3 className="text-sm font-bold text-text-tertiary mb-3">결정 투수</h3>
      <div className="flex justify-around">
        {pitchers.map((p) => {
          const style = ROLE_STYLE[p.role];
          return (
            <div key={p.role} className="flex flex-col items-center gap-1.5">
              <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${style.bg} ${style.text}`}>
                {style.label}
              </span>
              <PlayerAvatar name={p.name} teamId={p.teamId} photoUrl={getPlayerPhotoUrl(p.name)} size={48} />
              <span className="text-sm font-semibold text-text-primary">{p.name}</span>
              <span className="text-xs text-text-tertiary">{p.record} · ERA {p.era}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
