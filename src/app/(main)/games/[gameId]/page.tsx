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
import { getPreseasonGameById } from "@/lib/constants/preseason-schedule";
import { useLiveGame } from "@/lib/hooks/useLiveGame";
import { useGameDetail } from "@/lib/hooks/useGameDetail";
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

type Tab = "relay" | "chat" | "lineup" | "stats";

const TABS: { id: Tab; label: string }[] = [
  { id: "relay", label: "중계" },
  { id: "chat", label: "채팅" },
  { id: "lineup", label: "라인업" },
  { id: "stats", label: "스탯" },
];

export default function GameDetailPage() {
  const params = useParams();
  const gameId = params.gameId as string;
  const [activeTab, setActiveTab] = useState<Tab>("chat");
  const [aiOpen, setAiOpen] = useState(false);
  const { game: liveGame } = useLiveGame(gameId, 15000);
  const { data: gameDetail } = useGameDetail(gameId, 30000);

  const game = getGameById(gameId) ?? getPreseasonGameById(gameId);
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
  const gameStats = getStatsForGame(gameId);

  const isTopInning = game.inning?.includes("초");
  const battingTeamColor = isTopInning
    ? awayTeam.colorPrimary
    : homeTeam.colorPrimary;

  const d = deriveGameState(liveGame, game, gameDetail);

  return (
    <div className="flex flex-col min-h-[100dvh] bg-bg-primary overflow-y-auto pb-[104px] max-w-[640px] mx-auto w-full">
      <GameDetailHeader status={game.status} time={game.time} stadium={game.stadium} />

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
              <PlayByPlay plays={plays} teamColor={battingTeamColor} />
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
                      startingPitcher: {
                        name: gameDetail?.boxScore?.awayPitchers?.[0]?.name ?? "",
                        era: gameDetail?.boxScore?.awayPitchers?.[0]?.era ?? "-",
                      },
                      batters: d.detailLineup.away.map((e: LineupEntry) => ({
                        order: e.order, name: e.name, position: e.position, avg: "",
                      })),
                    },
                    home: {
                      teamId: game.homeTeamId,
                      startingPitcher: {
                        name: gameDetail?.boxScore?.homePitchers?.[0]?.name ?? "",
                        era: gameDetail?.boxScore?.homePitchers?.[0]?.era ?? "-",
                      },
                      batters: d.detailLineup.home.map((e: LineupEntry) => ({
                        order: e.order, name: e.name, position: e.position, avg: "",
                      })),
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
