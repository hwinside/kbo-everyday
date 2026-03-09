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
} from "@/lib/constants/games";
import { getStatsForGame } from "@/lib/constants/game-stats";
import { useLiveGame } from "@/lib/hooks/useLiveGame";
import { useGameDetail } from "@/lib/hooks/useGameDetail";
import type { LineupEntry, BatterRecord, PitcherRecord } from "@/lib/hooks/useGameDetail";

import ScoreBar from "@/components/game/ScoreBar";
import TeamLogo from "@/components/ui/TeamLogo";
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
  const gameStats = getStatsForGame(gameId);

  const isTopInning = game.inning?.includes("초");
  const battingTeamColor = isTopInning
    ? awayTeam.colorPrimary
    : homeTeam.colorPrimary;

  // Resolve live state (useLiveGame = BSO/runners/scores, useGameDetail = linescore/lineup/boxscore)
  const currentBalls = liveGame?.balls ?? 0;
  const currentStrikes = liveGame?.strikes ?? 0;
  const currentOuts = liveGame?.outs ?? 0;
  const currentRunner1b = liveGame?.runner1b ?? false;
  const currentRunner2b = liveGame?.runner2b ?? false;
  const currentRunner3b = liveGame?.runner3b ?? false;
  const currentBatter = liveGame?.currentBatter ?? null;
  const currentPitcher = liveGame?.currentPitcher ?? null;
  const currentInning = liveGame?.currentInning || game.inning || "";
  const awayScore = liveGame?.awayScore ?? game.awayScore;
  const homeScore = liveGame?.homeScore ?? game.homeScore;

  // Determine defensive side from gameDetail lineup
  const isTop = currentInning.includes("초");
  const detailLineup = gameDetail?.lineup;

  // Convert LineupEntry[] to the shape FieldViewV2 expects
  function toDefenders(entries: LineupEntry[]) {
    return entries.map(e => ({
      order: e.order,
      name: e.name,
      position: e.position,
      avg: "",
    }));
  }

  const defensiveSide = detailLineup
    ? (isTop ? toDefenders(detailLineup.home) : toDefenders(detailLineup.away))
    : null;

  // On-deck batters from lineup
  const onDeckBatters = (() => {
    if (!currentBatter || !detailLineup) return undefined;
    const inAway = detailLineup.away.some((b: LineupEntry) => b.name === currentBatter);
    const batters = inAway ? detailLineup.away : detailLineup.home;
    const currentIndex = batters.findIndex((b: LineupEntry) => b.name === currentBatter);
    if (currentIndex === -1) return undefined;
    const next: { order: number; name: string }[] = [];
    for (let i = 1; i <= 3; i++) {
      const idx = (currentIndex + i) % batters.length;
      next.push({ order: batters[idx].order, name: batters[idx].name });
    }
    return next;
  })();

  // Pitcher today stats from boxScore
  const pitcherToday = (() => {
    if (!currentPitcher || !gameDetail?.boxScore) return null;
    const allPitchers = [
      ...(gameDetail.boxScore.awayPitchers || []),
      ...(gameDetail.boxScore.homePitchers || []),
    ];
    return allPitchers.find((p: PitcherRecord) => p.name === currentPitcher) ?? null;
  })();

  // Batter today stats from boxScore
  const batterToday = (() => {
    if (!currentBatter || !gameDetail?.boxScore) return null;
    const allBatters = [
      ...(gameDetail.boxScore.awayBatters || []),
      ...(gameDetail.boxScore.homeBatters || []),
    ];
    return allBatters.find((b: BatterRecord) => b.name === currentBatter) ?? null;
  })();

  const pitcherEra = pitcherToday?.era;
  const batterAvg = batterToday?.avg;

  const isLive = liveGame?.isLive || game.status === "live";

  return (
    <div className="flex flex-col min-h-[100dvh] bg-bg-primary overflow-y-auto pb-[104px] max-w-[640px] mx-auto w-full">
      {/* ===== Header ===== */}
      <div className="flex items-center gap-2 px-4 py-1.5 sticky top-0 z-[100] bg-bg-primary">
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
        />
      ) : (
        /* Non-live: simple score display — same horizontal alignment as live */
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
      )}

      {/* ===== Linescore Table ===== */}
      {(gameDetail?.linescore || innings.length > 0) && (
        <LinescoreTable
          awayTeam={awayTeam}
          homeTeam={homeTeam}
          innings={innings}
          awayScore={awayScore}
          homeScore={homeScore}
          currentInning={currentInning}
          linescore={gameDetail?.linescore}
        />
      )}

      {/* ===== Field View (live with lineup) ===== */}
      {isLive && defensiveSide ? (
        <FieldViewV2
          defenders={defensiveSide}
          currentPitcher={currentPitcher}
          currentBatter={currentBatter}
          runner1b={currentRunner1b}
          runner2b={currentRunner2b}
          runner3b={currentRunner3b}
          runner1bName={liveGame?.runner1bName}
          runner2bName={liveGame?.runner2bName}
          runner3bName={liveGame?.runner3bName}
          onDeckBatters={onDeckBatters}
          balls={currentBalls}
          strikes={currentStrikes}
          outs={currentOuts}
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

      {/* BSO is now rendered inside FieldViewV2 */}

      {/* ===== Matchup Card (live only) ===== */}
      {isLive && (
        <MatchupCard
          currentPitcher={currentPitcher}
          currentBatter={currentBatter}
          pitcherEra={pitcherEra}
          batterAvg={batterAvg}
          pitcherToday={pitcherToday}
          batterToday={batterToday}
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
              {detailLineup ? (
                <LineupTab
                  lineup={{
                    gameId,
                    away: {
                      teamId: game.awayTeamId,
                      startingPitcher: {
                        name: gameDetail?.boxScore?.awayPitchers?.[0]?.name ?? "",
                        era: gameDetail?.boxScore?.awayPitchers?.[0]?.era ?? "-",
                      },
                      batters: detailLineup.away.map((e: LineupEntry) => ({
                        order: e.order,
                        name: e.name,
                        position: e.position,
                        avg: "",
                      })),
                    },
                    home: {
                      teamId: game.homeTeamId,
                      startingPitcher: {
                        name: gameDetail?.boxScore?.homePitchers?.[0]?.name ?? "",
                        era: gameDetail?.boxScore?.homePitchers?.[0]?.era ?? "-",
                      },
                      batters: detailLineup.home.map((e: LineupEntry) => ({
                        order: e.order,
                        name: e.name,
                        position: e.position,
                        avg: "",
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

      {/* Chat input is handled inside GameChat component */}
    </div>
  );
}
