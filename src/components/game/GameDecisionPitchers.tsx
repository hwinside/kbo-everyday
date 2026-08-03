"use client";

import type { CSSProperties } from "react";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { resolveRosterPlayer } from "@/lib/utils/player-roster";
import { resultToneChipStyle } from "@/lib/ui/result-tone";

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

// 승/패는 홈 팀카드 기준 SSOT(@/lib/ui/result-tone). 세는 승패가 아니라 역할 표시라 tone 체계 밖.
const ROLE_STYLE: Record<
  DecisionPitcher["role"],
  { label: string; className: string; style?: CSSProperties }
> = {
  WIN: { label: "승", className: "", style: resultToneChipStyle("positive") },
  LOSS: { label: "패", className: "", style: resultToneChipStyle("negative") },
  SAVE: { label: "세", className: "bg-blue-500/20 text-blue-400" },
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
              <span
                className={`text-xs font-bold px-2 py-0.5 rounded-full ${style.className}`}
                style={style.style}
              >
                {style.label}
              </span>
              <PlayerAvatar name={p.name} teamId={p.teamId} photoUrl={getPlayerPhotoUrl(p.name, resolveRosterPlayer({ name: p.name, teamId: p.teamId })?.kboId, p.teamId)} size={48} />
              <span className="text-sm font-semibold text-text-primary">{p.name}</span>
              <span className="text-xs text-text-tertiary">{p.record} · ERA {p.era}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
