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
  // 두 자리 이상 점수에서 팀명이 세로로 줄바꿈되지 않도록 폰트 크기를 양쪽 동일하게 축소
  const maxScore = Math.max(awayScore, homeScore);
  const scoreSize = maxScore >= 100 ? "text-[32px]" : maxScore >= 10 ? "text-[40px]" : "text-[48px]";
  return (
    <div className="flex items-center justify-center px-4 py-3">
      <div className="flex items-center gap-2.5 flex-1 justify-end">
        <span className="text-lg font-bold text-text-primary whitespace-nowrap">{awayTeam.shortName}</span>
        <TeamLogo team={awayTeam} size={40} />
        <span className={`${scoreSize} shrink-0 font-extrabold tabular-nums leading-none text-text-primary`}>{awayScore}</span>
      </div>
      <div className="flex flex-col items-center mx-3">
        <span className="text-xl text-text-tertiary font-light leading-none">:</span>
      </div>
      <div className="flex items-center gap-2.5 flex-1 justify-start">
        <span className={`${scoreSize} shrink-0 font-extrabold tabular-nums leading-none text-text-primary`}>{homeScore}</span>
        <TeamLogo team={homeTeam} size={40} />
        <span className="text-lg font-bold text-text-primary whitespace-nowrap">{homeTeam.shortName}</span>
      </div>
    </div>
  );
}
