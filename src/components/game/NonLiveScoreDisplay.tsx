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
  // max-[389px] compact: 320~389px 폭에서 간격·로고·팀명·점수를 동시 축소해 양팀 두 자리(14:10)도 px-4 안에 수납
  const maxScore = Math.max(awayScore, homeScore);
  const scoreSize =
    maxScore >= 100
      ? "text-[32px] max-[389px]:text-[24px]"
      : maxScore >= 10
        ? "text-[40px] max-[389px]:text-[30px]"
        : "text-[48px] max-[389px]:text-[40px]";
  const compactLogo =
    "max-[389px]:size-8! max-[389px]:p-0.5 max-[389px]:[&>img]:max-h-full max-[389px]:[&>img]:max-w-full";
  return (
    <div data-testid="score-row" className="flex items-center justify-center px-4 py-3">
      <div data-testid="score-away" className="flex items-center gap-2.5 max-[389px]:gap-1.5 flex-1 justify-end">
        <span className="text-lg max-[389px]:text-sm font-bold text-text-primary whitespace-nowrap">{awayTeam.shortName}</span>
        <TeamLogo team={awayTeam} size={40} className={compactLogo} />
        <span className={`${scoreSize} shrink-0 font-extrabold tabular-nums leading-none text-text-primary`}>{awayScore}</span>
      </div>
      <div className="flex flex-col items-center mx-3 max-[389px]:mx-2">
        <span className="text-xl text-text-tertiary font-light leading-none">:</span>
      </div>
      <div data-testid="score-home" className="flex items-center gap-2.5 max-[389px]:gap-1.5 flex-1 justify-start">
        <span className={`${scoreSize} shrink-0 font-extrabold tabular-nums leading-none text-text-primary`}>{homeScore}</span>
        <TeamLogo team={homeTeam} size={40} className={compactLogo} />
        <span className="text-lg max-[389px]:text-sm font-bold text-text-primary whitespace-nowrap">{homeTeam.shortName}</span>
      </div>
    </div>
  );
}
