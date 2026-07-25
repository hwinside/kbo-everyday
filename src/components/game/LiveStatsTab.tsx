"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { TeamData } from "@/lib/constants/teams";
import type { GameRelayResponse } from "@/lib/hooks/useGameRelay";
import type { GameStats, BatterStat, PitcherStat } from "@/lib/constants/game-stats";
import GameStatsTab from "./GameStatsTab";
import RelayInningCard from "./RelayInningCard";

interface LiveStatsTabProps {
  relay: GameRelayResponse;
  awayTeam: TeamData;
  homeTeam: TeamData;
  currentPitcher?: string | null;
  awayStarterName?: string;
  homeStarterName?: string;
}

/** relay playerStats → GameStats 변환 */
function relayToGameStats(
  relay: GameRelayResponse,
  awayTeamId: number,
  homeTeamId: number,
  pitcherNames?: { awayStarter?: string; homeStarter?: string },
): GameStats | null {
  const ps = relay.playerStats;
  if (!ps || (ps.awayBatters.length === 0 && ps.homeBatters.length === 0)) return null;

  type RB = NonNullable<GameRelayResponse["playerStats"]>["awayBatters"];
  type RP = NonNullable<GameRelayResponse["playerStats"]>["awayPitchers"];

  function toBatterStats(batters: RB): BatterStat[] {
    return batters.map((b) => ({
      order: b.batOrder,
      name: b.name,
      position: b.posName,
      ab: b.ab,
      r: b.run,
      h: b.hit,
      rbi: b.rbi,
      hr: b.hr,
      bb: b.bb,
      so: b.so,
      sb: 0, // Not available in relay
      avg: b.seasonAvg > 0 ? b.seasonAvg.toFixed(3).replace(/^0/, "") : ".000",
    }));
  }

  function toPitcherStats(pitchers: RP, fallbackName?: string): PitcherStat[] {
    return pitchers.map((p, i) => ({
      name: p.name || (i === 0 && fallbackName ? fallbackName : "투수"),
      ip: p.inn || "-",
      h: p.hits,
      r: p.runs,
      er: p.earnedRuns,
      bb: p.walks,
      so: p.strikeouts,
      hr: p.hr,
      bf: 0,
      ab: 0,
      np: p.pitchCount,
      g: 0,
      w: 0,
      l: 0,
      sv: 0,
      hd: 0,
      era: p.seasonEra > 0 ? p.seasonEra.toFixed(2) : "-",
    }));
  }

  return {
    gameId: relay.gameId,
    away: {
      teamId: awayTeamId,
      batters: toBatterStats(ps.awayBatters),
      pitchers: toPitcherStats(ps.awayPitchers, pitcherNames?.awayStarter),
    },
    home: {
      teamId: homeTeamId,
      batters: toBatterStats(ps.homeBatters),
      pitchers: toPitcherStats(ps.homePitchers, pitcherNames?.homeStarter),
    },
  };
}

export default function LiveStatsTab({
  relay,
  awayTeam,
  homeTeam,
  currentPitcher,
  awayStarterName,
  homeStarterName,
}: LiveStatsTabProps) {
  const [collapseInnings, setCollapseInnings] = useState(false);

  const orderedInnings = relay.innings;

  // Convert relay playerStats to GameStats for reuse
  const gameStats = relayToGameStats(relay, awayTeam.id, homeTeam.id, {
    awayStarter: awayStarterName,
    homeStarter: homeStarterName,
  });

  if (orderedInnings.length === 0 && !gameStats) {
    return (
      <div className="flex flex-col items-center justify-center h-32 gap-2">
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
          <span className="text-yellow-400 text-sm">⚠️</span>
          <span className="text-sm text-yellow-400/90">
            경기 데이터를 불러오는 중입니다...
          </span>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Section 1: 이닝별 주요 기록 */}
      {orderedInnings.length > 0 && (
        <div className="px-5 py-4 space-y-1">
          <div className="glass-card p-3 mb-3">
            <p className="text-sm font-semibold text-text-primary">
              이닝별 주요 기록
            </p>
          </div>

          <div className="space-y-2">
            {/* 전체 이닝 기본 펼침 — 접기 토글 */}
            {orderedInnings.length > 3 && (
              <button
                onClick={() => setCollapseInnings(!collapseInnings)}
                className="w-full flex items-center justify-center gap-1.5 px-4 py-2 text-text-tertiary hover:bg-black/5 dark:hover:bg-white/5 transition-colors rounded-lg border border-border/30"
              >
                {collapseInnings ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                <span className="text-[11px] font-medium">
                  {collapseInnings ? `전체 이닝별 기록 보기 (${orderedInnings.length}개)` : "이닝별 기록 접기"}
                </span>
              </button>
            )}

            {!collapseInnings && orderedInnings.map((inning) => (
              <RelayInningCard
                key={`${inning.inning}-${inning.half}`}
                inning={inning}
                awayTeam={awayTeam}
                homeTeam={homeTeam}
              />
            ))}
          </div>
        </div>
      )}

      {/* Section 2: 타자/투수 기록 (종료 경기와 동일 포맷) */}
      {gameStats && (
        <GameStatsTab stats={gameStats} awayTeam={awayTeam} homeTeam={homeTeam} isLive />
      )}
    </div>
  );
}
