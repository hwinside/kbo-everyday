"use client";

import TeamLogo from "@/components/ui/TeamLogo";
import type { TeamData } from "@/lib/constants/teams";

interface NonLiveScoreDisplayProps {
  awayTeam: TeamData;
  homeTeam: TeamData;
  awayScore: number;
  homeScore: number;
}

export default function NonLiveScoreDisplay({ awayTeam, homeTeam, awayScore, homeScore }: NonLiveScoreDisplayProps) {
  return (
    <div className="flex items-center justify-center px-4 py-3">
      <div className="flex items-center gap-2.5 flex-1 justify-end">
        <span className="text-lg font-bold text-white">{awayTeam.shortName}</span>
        <TeamLogo team={awayTeam} size={40} />
        <span className="text-[48px] font-extrabold tabular-nums leading-none text-white">{awayScore}</span>
      </div>
      <div className="flex flex-col items-center mx-3">
        <span className="text-xl text-[#555] font-light leading-none">:</span>
      </div>
      <div className="flex items-center gap-2.5 flex-1 justify-start">
        <span className="text-[48px] font-extrabold tabular-nums leading-none text-white">{homeScore}</span>
        <TeamLogo team={homeTeam} size={40} />
        <span className="text-lg font-bold text-white">{homeTeam.shortName}</span>
      </div>
    </div>
  );
}
