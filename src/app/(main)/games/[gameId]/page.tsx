"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { clsx } from "clsx";
import { getTeamById } from "@/lib/constants/teams";
import {
  getGameById,
  getInningsForGame,
  getPlaysForGame,
} from "@/lib/constants/games";
import { getStatsForGame } from "@/lib/constants/game-stats";
import type { GameStats, BatterStat, PitcherStat } from "@/lib/constants/game-stats";
import type { GameDetailResponse } from "@/app/api/game-detail/route";
import { getPreseasonGameById } from "@/lib/constants/preseason-schedule";
import { useLiveGame } from "@/lib/hooks/useLiveGame";
import { useGameDetail } from "@/lib/hooks/useGameDetail";
import { useGameEvents } from "@/lib/hooks/useGameEvents";
import type { LineupEntry } from "@/lib/hooks/useGameDetail";
import { deriveGameState } from "@/lib/utils/game-derived";
import GameDetailHeader from "@/components/game/GameDetailHeader";
import NonLiveScoreDisplay from "@/components/game/NonLiveScoreDisplay";
import ScoreBar from "@/components/game/ScoreBar";
import LinescoreTable from "@/components/game/LinescoreTable";
import FieldViewV2 from "@/components/game/FieldViewV2";
import MatchupCard from "@/components/game/MatchupCard";
import Diamond from "@/components/game/Diamond";
import ScoreBoard from "@/components/game/ScoreBoard";
import PlayByPlay from "@/components/game/PlayByPlay";
import GameChat from "@/components/game/GameChat";
import AIAnalysis from "@/components/game/AIAnalysis";
import LineupTab from "@/components/game/LineupTab";
import GameStatsTab from "@/components/game/GameStatsTab";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";

type Tab = "relay" | "chat" | "lineup" | "stats";

const TABS: { id: Tab; label: string }[] = [
  { id: "relay", label: "중계" },
  { id: "chat", label: "채팅" },
  { id: "lineup", label: "라인업" },
  { id: "stats", label: "스탯" },
];

/* boxScore → GameStats 변환 */
function boxScoreToGameStats(
  gameId: string,
  boxScore: NonNullable<GameDetailResponse["boxScore"]>,
  awayTeamId: number,
  homeTeamId: number,
): GameStats {
  const DECISION_MAP: Record<string, PitcherStat["result"]> = {
    "승": "win", "패": "loss", "세": "save", "홀": "hold",
  };

  function toBatterStats(batters: typeof boxScore.awayBatters): BatterStat[] {
    return batters.map(b => ({
      order: b.order,
      name: b.name,
      position: b.positionFull || b.position,
      ab: b.atBats,
      r: b.runs,
      h: b.hits,
      rbi: b.rbi,
      hr: b.hr,
      bb: b.bb,
      so: b.so,
      sb: b.sb,
      avg: b.avg,
      isSubstitute: b.isSubstitute,
    }));
  }

  function toPitcherStats(pitchers: typeof boxScore.awayPitchers): PitcherStat[] {
    return pitchers.map(p => ({
      name: p.name,
      result: DECISION_MAP[p.decision],
      ip: p.inningsPitched,
      h: p.hits,
      r: p.runs,
      er: p.earnedRuns,
      bb: p.walks,
      so: p.strikeouts,
      hr: p.hr,
      bf: p.battersFaced,
      ab: p.atBats,
      np: p.pitchCount,
      g: 1,
      w: DECISION_MAP[p.decision] === "win" ? 1 : 0,
      l: DECISION_MAP[p.decision] === "loss" ? 1 : 0,
      sv: DECISION_MAP[p.decision] === "save" ? 1 : 0,
      era: p.era,
    }));
  }

  return {
    gameId,
    away: { teamId: awayTeamId, batters: toBatterStats(boxScore.awayBatters), pitchers: toPitcherStats(boxScore.awayPitchers) },
    home: { teamId: homeTeamId, batters: toBatterStats(boxScore.homeBatters), pitchers: toPitcherStats(boxScore.homePitchers) },
  };
}

/* KBO G_ID → 팀 코드 파싱 (예: "20260312LGNC0" → away=LG, home=NC) */
const KBO_CODE_TO_ID: Record<string, number> = {
  LG: 1, OB: 2, KT: 3, SK: 4, NC: 5,
  HT: 6, LT: 7, SS: 8, HH: 9, WO: 10,
};

function parseKboGameId(gameId: string) {
  // Format: YYYYMMDD + 2-char away + 2-char home + game#
  const m = gameId.match(/^(\d{8})([A-Z]{2})([A-Z]{2})(\d)$/);
  if (!m) return undefined;
  const [, dateStr, awayCode, homeCode] = m;
  const awayTeamId = KBO_CODE_TO_ID[awayCode];
  const homeTeamId = KBO_CODE_TO_ID[homeCode];
  if (!awayTeamId || !homeTeamId) return undefined;
  return {
    id: gameId,
    date: `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`,
    time: "13:00",
    homeTeamId,
    awayTeamId,
    status: "scheduled" as const,
    inning: null,
    homeScore: 0,
    awayScore: 0,
    stadium: "",
    updatedAt: "",
  };
}

export default function GameDetailPage() {
  const params = useParams();
  const gameId = params.gameId as string;
  const [activeTab, setActiveTab] = useState<Tab>("chat");
  const [aiOpen, setAiOpen] = useState(false);
  const { game: liveGame } = useLiveGame(gameId, 15000);
  const { data: gameDetail } = useGameDetail(gameId, 30000);
  const { events: gameEvents } = useGameEvents(gameId, liveGame?.isLive ?? false, 15000);

  const game = getGameById(gameId) ?? getPreseasonGameById(gameId) ?? parseKboGameId(gameId);
  if (!game) {
    return (
      <div className="flex items-center justify-center h-screen text-text-secondary">
        경기를 찾을 수 없습니다
      </div>
    );
  }

  const homeTeam = getTeamById(game.homeTeamId)!;
  const awayTeam = getTeamById(game.awayTeamId)!;
  const innings = getInningsForGame(gameId);
  const plays = getPlaysForGame(gameId);
  const staticGameStats = getStatsForGame(gameId);
  const gameStats = staticGameStats ?? (gameDetail?.boxScore
    ? boxScoreToGameStats(gameId, gameDetail.boxScore, game.awayTeamId, game.homeTeamId)
    : null);

  const isTopInning = game.inning?.includes("초");
  const battingTeamColor = isTopInning
    ? awayTeam.colorPrimary
    : homeTeam.colorPrimary;

  const d = deriveGameState(liveGame, game, gameDetail);

  return (
    <div className="flex flex-col min-h-[100dvh] bg-bg-primary overflow-y-auto pb-[104px] max-w-[640px] mx-auto w-full">
      <GameDetailHeader status={d.derivedStatus} time={game.time} stadium={liveGame?.stadium || game.stadium} />

      {d.isLive ? (
        <ScoreBar
          awayTeam={awayTeam}
          homeTeam={homeTeam}
          awayScore={d.awayScore}
          homeScore={d.homeScore}
          currentInning={d.currentInning}
        />
      ) : (
        <NonLiveScoreDisplay
          awayTeam={awayTeam}
          homeTeam={homeTeam}
          awayScore={d.awayScore}
          homeScore={d.homeScore}
        />
      )}

      {(gameDetail?.linescore || innings.length > 0) && (
        <LinescoreTable
          awayTeam={awayTeam}
          homeTeam={homeTeam}
          innings={innings}
          awayScore={d.awayScore}
          homeScore={d.homeScore}
          currentInning={d.currentInning}
          linescore={gameDetail?.linescore}
        />
      )}

      {d.isLive && d.defensiveSide ? (
        <FieldViewV2
          defenders={d.defensiveSide}
          currentPitcher={d.currentPitcher}
          currentBatter={d.currentBatter}
          runner1b={d.currentRunner1b}
          runner2b={d.currentRunner2b}
          runner3b={d.currentRunner3b}
          runner1bName={d.runner1bName}
          runner2bName={d.runner2bName}
          runner3bName={d.runner3bName}
          onDeckBatters={d.onDeckBatters}
          balls={d.currentBalls}
          strikes={d.currentStrikes}
          outs={d.currentOuts}
        />
      ) : d.isLive && !d.defensiveSide ? (
        <div className="flex justify-center py-3">
          <Diamond
            runner1b={d.currentRunner1b}
            runner2b={d.currentRunner2b}
            runner3b={d.currentRunner3b}
            teamColor={battingTeamColor}
          />
        </div>
      ) : null}

      {d.isLive && (
        <MatchupCard
          currentPitcher={d.currentPitcher}
          currentBatter={d.currentBatter}
          pitcherEra={d.pitcherEra}
          batterAvg={d.batterAvg}
          pitcherToday={d.pitcherToday}
          batterToday={d.batterToday}
        />
      )}

      {!d.isLive && innings.length === 0 && game.status === "final" && (
        <div className="px-4 pb-2">
          <ScoreBoard
            awayTeam={awayTeam}
            homeTeam={homeTeam}
            innings={innings}
            awayScore={d.awayScore}
            homeScore={d.homeScore}
            currentInning={game.inning}
          />
        </div>
      )}

      <AIAnalysis
        isOpen={aiOpen}
        onClose={() => setAiOpen(false)}
        awayTeamId={game.awayTeamId}
        homeTeamId={game.homeTeamId}
      />

      {/* Tabs */}
      <div className="flex border-b border-[#1a1a2e] mx-4">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={clsx(
              "flex-1 py-2.5 text-[13px] font-medium transition-colors relative",
              activeTab === tab.id ? "text-white font-semibold" : "text-[#888]"
            )}
          >
            {tab.label}
            {activeTab === tab.id && (
              <motion.div
                layoutId="tab-indicator"
                className="absolute bottom-[-1px] left-[20%] right-[20%] h-0.5 bg-white rounded-sm"
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
              />
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1">
        <AnimatePresence mode="wait">
          {activeTab === "relay" && (
            <motion.div key="relay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
              <PlayByPlay plays={plays} teamColor={battingTeamColor} gameEvents={gameEvents.length > 0 ? gameEvents : undefined} />
            </motion.div>
          )}
          {activeTab === "chat" && (
            <motion.div key="chat" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
              <GameChat gameId={gameId} homeTeamId={homeTeam.id} awayTeamId={awayTeam.id} />
            </motion.div>
          )}
          {activeTab === "lineup" && (
            <motion.div key="lineup" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              {d.detailLineup ? (
                <LineupTab
                  lineup={{
                    gameId,
                    away: {
                      teamId: game.awayTeamId,
                      startingPitcher: (() => {
                        const spName = gameDetail?.boxScore?.awayPitchers?.[0]?.name ?? "";
                        const spRoster = spName ? PLAYERS_ROSTER.find((p: { name: string; teamId: number; kboId: string }) => p.name === spName && p.teamId === game.awayTeamId) : undefined;
                        return { name: spName, era: gameDetail?.boxScore?.awayPitchers?.[0]?.era ?? "-", kboId: spRoster?.kboId };
                      })(),
                      batters: d.detailLineup.away.map((e: LineupEntry) => {
                        const roster = PLAYERS_ROSTER.find((p: { name: string; teamId: number; kboId: string }) => p.name === e.name && p.teamId === game.awayTeamId);
                        return { order: e.order, name: e.name, position: e.position, avg: e.avg || "", kboId: roster?.kboId, teamId: game.awayTeamId };
                      }),
                    },
                    home: {
                      teamId: game.homeTeamId,
                      startingPitcher: (() => {
                        const spName = gameDetail?.boxScore?.homePitchers?.[0]?.name ?? "";
                        const spRoster = spName ? PLAYERS_ROSTER.find((p: { name: string; teamId: number; kboId: string }) => p.name === spName && p.teamId === game.homeTeamId) : undefined;
                        return { name: spName, era: gameDetail?.boxScore?.homePitchers?.[0]?.era ?? "-", kboId: spRoster?.kboId };
                      })(),
                      batters: d.detailLineup.home.map((e: LineupEntry) => {
                        const roster = PLAYERS_ROSTER.find((p: { name: string; teamId: number; kboId: string }) => p.name === e.name && p.teamId === game.homeTeamId);
                        return { order: e.order, name: e.name, position: e.position, avg: e.avg || "", kboId: roster?.kboId, teamId: game.homeTeamId };
                      }),
                    },
                  }}
                  awayTeam={awayTeam}
                  homeTeam={homeTeam}
                />
              ) : (
                <div className="flex items-center justify-center h-32 text-text-tertiary text-base">
                  라인업 정보가 없습니다
                </div>
              )}
            </motion.div>
          )}
          {activeTab === "stats" && (
            <motion.div key="stats" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              {gameStats ? (
                <GameStatsTab stats={gameStats} awayTeam={awayTeam} homeTeam={homeTeam} />
              ) : (
                <div className="flex items-center justify-center h-32 text-text-tertiary text-base">
                  스탯 정보가 없습니다
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
