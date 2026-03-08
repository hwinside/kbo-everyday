"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { clsx } from "clsx";
import { getTeamById } from "@/lib/constants/teams";
import {
  getGameById,
  getInningsForGame,
  getPlaysForGame,
  MOCK_GAME_STATE,
  MOCK_LINEUP,
} from "@/lib/constants/games";
import { getStatsForGame } from "@/lib/constants/game-stats";
import { useLiveGame } from "@/lib/hooks/useLiveGame";

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

  const game = getGameById(gameId);
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
  const gameState = game.id === MOCK_GAME_STATE.gameId ? MOCK_GAME_STATE : null;
  const lineup = game.id === MOCK_LINEUP.gameId ? MOCK_LINEUP : null;
  const gameStats = getStatsForGame(gameId);

  const isTopInning = game.inning?.includes("초");
  const battingTeamColor = isTopInning
    ? awayTeam.colorPrimary
    : homeTeam.colorPrimary;

  // Resolve live state
  const currentBalls = liveGame?.balls ?? gameState?.balls ?? 0;
  const currentStrikes = liveGame?.strikes ?? gameState?.strikes ?? 0;
  const currentOuts = liveGame?.outs ?? gameState?.outs ?? 0;
  const currentRunner1b = liveGame?.runner1b ?? gameState?.runner1b ?? false;
  const currentRunner2b = liveGame?.runner2b ?? gameState?.runner2b ?? false;
  const currentRunner3b = liveGame?.runner3b ?? gameState?.runner3b ?? false;
  const currentBatter = liveGame?.currentBatter ?? gameState?.currentBatter ?? null;
  const currentPitcher = liveGame?.currentPitcher ?? gameState?.currentPitcher ?? null;
  const currentInning = liveGame?.currentInning || game.inning || "";
  const awayScore = liveGame?.awayScore ?? game.awayScore;
  const homeScore = liveGame?.homeScore ?? game.homeScore;

  // Determine defensive side for field view
  const isTop = currentInning.includes("초");
  const defensiveSide = isTop ? lineup?.home : lineup?.away;

  // On-deck batters
  const onDeckBatters = (() => {
    if (!currentBatter || !lineup) return undefined;
    const inAway = lineup.away.batters.some((b) => b.name === currentBatter);
    const batters = inAway ? lineup.away.batters : lineup.home.batters;
    const currentIndex = batters.findIndex((b) => b.name === currentBatter);
    if (currentIndex === -1) return undefined;
    const next: { order: number; name: string }[] = [];
    for (let i = 1; i <= 3; i++) {
      const idx = (currentIndex + i) % batters.length;
      next.push({ order: batters[idx].order, name: batters[idx].name });
    }
    return next;
  })();

  // Pitcher ERA from lineup
  const pitcherSide = isTop ? lineup?.home : lineup?.away;
  const pitcherEra = pitcherSide?.startingPitcher.era;

  // Batter AVG from lineup
  const batterData =
    lineup?.away.batters.find((b) => b.name === currentBatter) ||
    lineup?.home.batters.find((b) => b.name === currentBatter);
  const batterAvg = batterData?.avg;
  const batterBats = batterData?.bats ?? null;

  const isLive = game.status === "live" && gameState;

  return (
    <div className="flex flex-col min-h-[100dvh] bg-bg-primary overflow-y-auto pb-[52px] max-w-[640px] mx-auto w-full">
      {/* ===== Header ===== */}
      <div className="flex items-center gap-2 px-4 py-2.5 sticky top-0 z-[100] bg-bg-primary">
        <Link href="/games" className="p-1 -ml-1">
          <ArrowLeft className="w-[18px] h-[18px] text-[#888]" />
        </Link>
        {game.status === "live" && (
          <span className="text-[10px] font-bold text-white bg-[#e53935] px-1.5 py-0.5 rounded-[3px] animate-pulse">
            ● LIVE
          </span>
        )}
        {game.status === "final" && (
          <span className="text-[13px] text-[#888]">경기 종료</span>
        )}
        {game.status === "scheduled" && (
          <span className="text-[13px] text-[#888]">{game.time} 예정</span>
        )}
        <span className="text-[13px] text-[#888]">{game.stadium}</span>
      </div>

      {/* ===== Sticky Score Bar (live only) ===== */}
      {isLive ? (
        <ScoreBar
          awayTeam={awayTeam}
          homeTeam={homeTeam}
          awayScore={awayScore}
          homeScore={homeScore}
          currentInning={currentInning}
          balls={currentBalls}
          strikes={currentStrikes}
          outs={currentOuts}
          runner1b={currentRunner1b}
          runner2b={currentRunner2b}
          runner3b={currentRunner3b}
        />
      ) : (
        /* Non-live: simple score display */
        <div className="flex items-center justify-center gap-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-white">{awayTeam.shortName}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-2xl font-bold tabular-nums text-white">{awayScore}</span>
            <span className="text-base text-[#555]">:</span>
            <span className="text-2xl font-bold tabular-nums text-white">{homeScore}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-white">{homeTeam.shortName}</span>
          </div>
        </div>
      )}

      {/* ===== Linescore Table ===== */}
      {innings.length > 0 && (
        <LinescoreTable
          awayTeam={awayTeam}
          homeTeam={homeTeam}
          innings={innings}
          awayScore={awayScore}
          homeScore={homeScore}
          currentInning={currentInning}
        />
      )}

      {/* ===== Field View (live with lineup) ===== */}
      {isLive && defensiveSide ? (
        <FieldViewV2
          defenders={defensiveSide.batters}
          currentPitcher={currentPitcher}
          currentBatter={currentBatter}
          runner1b={currentRunner1b}
          runner2b={currentRunner2b}
          runner3b={currentRunner3b}
          runner1bName={gameState?.runner1bName}
          runner2bName={gameState?.runner2bName}
          runner3bName={gameState?.runner3bName}
          onDeckBatters={onDeckBatters}
          batterBats={batterBats}
        />
      ) : isLive && !defensiveSide ? (
        /* Fallback small diamond */
        <div className="flex justify-center py-3">
          <Diamond
            runner1b={currentRunner1b}
            runner2b={currentRunner2b}
            runner3b={currentRunner3b}
            teamColor={battingTeamColor}
          />
        </div>
      ) : null}

      {/* ===== Matchup Card (live only) ===== */}
      {isLive && (
        <MatchupCard
          currentPitcher={currentPitcher}
          currentBatter={currentBatter}
          pitcherEra={pitcherEra}
          batterAvg={batterAvg}
        />
      )}

      {/* Non-live: existing ScoreBoard for finished/scheduled games without live linescore */}
      {!isLive && innings.length === 0 && game.status === "final" && (
        <div className="px-4 pb-2">
          <ScoreBoard
            awayTeam={awayTeam}
            homeTeam={homeTeam}
            innings={innings}
            awayScore={awayScore}
            homeScore={homeScore}
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

      {/* ===== Tabs ===== */}
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

      {/* ===== Tab content ===== */}
      <div className="flex-1">
        <AnimatePresence mode="wait">
          {activeTab === "relay" && (
            <motion.div
              key="relay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="h-full"
            >
              <PlayByPlay plays={plays} teamColor={battingTeamColor} />
            </motion.div>
          )}

          {activeTab === "chat" && (
            <motion.div
              key="chat"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="h-full"
            >
              <GameChat gameId={gameId} homeTeamId={homeTeam.id} awayTeamId={awayTeam.id} />
            </motion.div>
          )}

          {activeTab === "lineup" && (
            <motion.div
              key="lineup"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              {lineup ? (
                <LineupTab lineup={lineup} awayTeam={awayTeam} homeTeam={homeTeam} />
              ) : (
                <div className="flex items-center justify-center h-32 text-text-tertiary text-base">
                  라인업 정보가 없습니다
                </div>
              )}
            </motion.div>
          )}

          {activeTab === "stats" && (
            <motion.div
              key="stats"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
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
