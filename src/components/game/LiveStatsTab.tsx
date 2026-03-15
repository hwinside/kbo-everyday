"use client";

import { clsx } from "clsx";
import type { TeamData } from "@/lib/constants/teams";
import type { GameRelayResponse, InningRelay, PlayEvent } from "@/lib/hooks/useGameRelay";

interface LiveStatsTabProps {
  relay: GameRelayResponse;
  awayTeam: TeamData;
  homeTeam: TeamData;
}

function getPlayStyle(type: PlayEvent["type"]) {
  switch (type) {
    case "homerun":
      return "text-accent font-semibold";
    case "hit":
      return "text-accent";
    case "strikeout":
      return "text-text-tertiary";
    case "walk":
    case "hbp":
      return "text-text-secondary";
    case "error":
      return "text-red-400";
    default:
      return "text-text-secondary";
  }
}

function getPlayEmoji(type: PlayEvent["type"]) {
  if (type === "homerun") return " \uD83D\uDD25";
  if (type === "hit") return " \u26BE";
  return "";
}

function getTeamColor(inning: InningRelay, awayTeam: TeamData, homeTeam: TeamData): string {
  return inning.half === "top" ? awayTeam.colorPrimary : homeTeam.colorPrimary;
}

function getHalfLabel(half: "top" | "bottom"): string {
  return half === "top" ? "초" : "말";
}

function countScoring(plays: PlayEvent[]): number {
  let scores = 0;
  for (const play of plays) {
    if (play.extras) {
      for (const extra of play.extras) {
        if (extra.includes("홈까지 진루") || extra.includes("득점")) {
          scores++;
        }
      }
    }
    if (play.type === "homerun") {
      // Count runners scoring from extras, but the batter always scores on HR
      // Only add batter score if not already counted in extras
      const hasExtraScore = play.extras?.some(
        (e) => e.includes("홈까지 진루") || e.includes("득점")
      );
      if (!hasExtraScore) scores++;
    }
  }
  return scores;
}

export default function LiveStatsTab({
  relay,
  awayTeam,
  homeTeam,
}: LiveStatsTabProps) {
  // Display innings in reverse order (latest first)
  const reversedInnings = [...relay.innings].reverse();

  if (reversedInnings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-32 gap-2">
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
          <span className="text-yellow-400 text-sm">&#9888;&#65039;</span>
          <span className="text-sm text-yellow-400/90">
            경기 데이터를 불러오는 중입니다...
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="px-5 py-4 space-y-1">
      {/* Header */}
      <div className="glass-card p-3 mb-3">
        <p className="text-sm font-semibold text-text-primary">
          이닝별 주요 기록
        </p>
        <p className="text-xs text-text-tertiary mt-0.5">
          경기 종료 후 전체 스탯이 제공됩니다
        </p>
      </div>

      {/* Innings */}
      <div className="space-y-2">
        {reversedInnings.map((inning) => {
          const teamColor = getTeamColor(inning, awayTeam, homeTeam);
          const scores = countScoring(inning.plays);

          return (
            <div
              key={`${inning.inning}-${inning.half}`}
              className="glass-card overflow-hidden"
            >
              {/* Inning header */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-border/30">
                <div
                  className="w-1 h-4 rounded-full shrink-0"
                  style={{ backgroundColor: teamColor }}
                />
                <span className="text-sm font-semibold text-text-primary">
                  {inning.inning}회{getHalfLabel(inning.half)}
                </span>
                <span
                  className="text-sm font-medium"
                  style={{ color: teamColor }}
                >
                  {inning.teamName}
                </span>
                {scores > 0 && (
                  <span className="ml-auto text-xs font-bold text-accent bg-accent/10 px-1.5 py-0.5 rounded">
                    {scores}점
                  </span>
                )}
              </div>

              {/* Plays */}
              <div className="px-3 py-1.5">
                {inning.plays.length === 0 ? (
                  <p className="text-xs text-text-tertiary py-1">
                    기록 없음
                  </p>
                ) : (
                  inning.plays.map((play, i) => {
                    const isLast = i === inning.plays.length - 1;
                    const hasScoring = play.extras?.some(
                      (e) =>
                        e.includes("홈까지 진루") || e.includes("득점")
                    );

                    return (
                      <div
                        key={`${play.batterName}-${i}`}
                        className={clsx(
                          "flex items-start gap-2 py-1.5",
                          !isLast && "border-b border-border/20"
                        )}
                      >
                        {/* Tree connector */}
                        <span className="text-text-tertiary text-xs mt-0.5 shrink-0 w-3 text-center">
                          {isLast ? "\u2514" : "\u251C"}
                        </span>

                        {/* Batter name */}
                        <span className="text-sm text-text-primary font-medium shrink-0 min-w-[48px]">
                          {play.batterName}
                        </span>

                        {/* Result */}
                        <span
                          className={clsx(
                            "text-sm flex-1",
                            getPlayStyle(play.type)
                          )}
                        >
                          {play.result}
                          {getPlayEmoji(play.type)}
                        </span>

                        {/* Scoring badge */}
                        {hasScoring && (
                          <span className="text-[10px] font-bold text-accent bg-accent/10 px-1 py-0.5 rounded shrink-0">
                            +득점
                          </span>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
