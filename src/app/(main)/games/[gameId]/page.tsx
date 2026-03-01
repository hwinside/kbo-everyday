"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { clsx } from "clsx";
import { getTeamById } from "@/lib/constants/teams";
import TeamLogo from "@/components/ui/TeamLogo";
import {
  getGameById,
  getInningsForGame,
  getPlaysForGame,
  MOCK_GAME_STATE,
  MOCK_CHAT_MESSAGES,
  MOCK_LINEUP,
} from "@/lib/constants/games";
import TeamComparisonBar from "@/components/game/TeamComparisonBar";
import GameDecisionPitchers from "@/components/game/GameDecisionPitchers";
import StadiumInfo from "@/components/game/StadiumInfo";
import { getStatsForGame } from "@/lib/constants/game-stats";

import ScoreBoard from "@/components/game/ScoreBoard";
import Diamond from "@/components/game/Diamond";
import CountIndicator from "@/components/game/CountIndicator";
import RadioPlayer from "@/components/game/RadioPlayer";
import PlayByPlay from "@/components/game/PlayByPlay";
import GameChat from "@/components/game/GameChat";
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

  // Determine which team color to use for the current batting team
  const isTopInning = game.inning?.includes("초");
  const battingTeamColor = isTopInning
    ? awayTeam.colorPrimary
    : homeTeam.colorPrimary;

  return (
    <div className="flex flex-col min-h-[100dvh] bg-bg-primary overflow-y-auto">
      {/* ===== Sticky top section ===== */}
      <div
        className="border-b border-border bg-bg-primary/80 backdrop-blur-xl"
        style={{
          backgroundImage: `linear-gradient(135deg, ${awayTeam.colorPrimary}08, transparent, ${homeTeam.colorPrimary}08)`,
        }}
      >
        {/* Back button + game info */}
        <div className="flex items-center gap-4 px-4 pt-2">
          <Link href="/games" className="p-1 -ml-1">
            <ArrowLeft className="w-5 h-5 text-text-secondary" />
          </Link>
          <div className="flex-1">
            {game.status === "live" && (
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
                <span className="text-base font-semibold text-accent">LIVE</span>
                <span className="text-base text-text-tertiary ml-1">
                  {game.stadium}
                </span>
              </div>
            )}
            {game.status === "final" && (
              <span className="text-base text-text-tertiary">
                경기 종료 · {game.stadium}
              </span>
            )}
            {game.status === "scheduled" && (
              <span className="text-base text-text-tertiary">
                {game.time} 예정 · {game.stadium}
              </span>
            )}
          </div>
        </div>

        {/* Radio player */}
        {game.status === "live" && (
          <div className="px-4 pt-2">
            <RadioPlayer />
          </div>
        )}

        {/* Score header */}
        <div className="flex items-center justify-center gap-4 px-5 py-4">
          {/* Away team */}
          <div className="flex items-center gap-3">
            <TeamLogo
              team={awayTeam}
              size={64}
              className="shadow-lg"
              style={{ boxShadow: `0 0 20px ${awayTeam.colorPrimary}40` }}
            />
            <span className="text-base font-semibold text-text-primary">
              {awayTeam.shortName}
            </span>
          </div>

          {/* Score */}
          <div className="flex items-center gap-4">
            <motion.span
              key={`away-${game.awayScore}`}
              initial={{ scale: 1.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="text-3xl font-bold tabular-nums text-text-primary"
            >
              {game.awayScore}
            </motion.span>
            <div className="flex flex-col items-center">
              <span className="text-base text-text-tertiary">:</span>
              {game.inning && (
                <span className="text-base text-text-secondary mt-0.5">
                  {game.inning}
                </span>
              )}
            </div>
            <motion.span
              key={`home-${game.homeScore}`}
              initial={{ scale: 1.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="text-3xl font-bold tabular-nums text-text-primary"
            >
              {game.homeScore}
            </motion.span>
          </div>

          {/* Home team */}
          <div className="flex items-center gap-3">
            <span className="text-base font-semibold text-text-primary">
              {homeTeam.shortName}
            </span>
            <TeamLogo
              team={homeTeam}
              size={64}
              className="shadow-lg"
              style={{ boxShadow: `0 0 20px ${homeTeam.colorPrimary}40` }}
            />
          </div>
        </div>

        {/* Diamond + Count (only for live games) */}
        {game.status === "live" && gameState && (
          <div className="flex items-center gap-4 px-5 pb-2">
            <Diamond
              runner1b={gameState.runner1b}
              runner2b={gameState.runner2b}
              runner3b={gameState.runner3b}
              teamColor={battingTeamColor}
            />
            <div className="flex-1">
              <CountIndicator
                balls={gameState.balls}
                strikes={gameState.strikes}
                outs={gameState.outs}
                currentBatter={gameState.currentBatter}
                currentPitcher={gameState.currentPitcher}
              />
            </div>
          </div>
        )}

        {/* Inning score table */}
        {innings.length > 0 && (
          <div className="px-4 pb-2">
            <ScoreBoard
              awayTeam={awayTeam}
              homeTeam={homeTeam}
              innings={innings}
              awayScore={game.awayScore}
              homeScore={game.homeScore}
              currentInning={game.inning}
            />
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-t border-border">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                "flex-1 py-3 text-base font-medium transition-colors relative",
                activeTab === tab.id
                  ? "text-text-primary"
                  : "text-text-tertiary"
              )}
            >
              {tab.label}
              {activeTab === tab.id && (
                <motion.div
                  layoutId="tab-indicator"
                  className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent"
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                />
              )}
            </button>
          ))}
        </div>
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
              <GameChat messages={MOCK_CHAT_MESSAGES} homeTeamId={homeTeam.id} awayTeamId={awayTeam.id} />
            </motion.div>
          )}

          {activeTab === "lineup" && (
            <motion.div
              key="lineup"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className=""
            >
              {lineup ? (
                <LineupTab
                  lineup={lineup}
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
              className=""
            >
              {gameStats ? (
                <GameStatsTab
                  stats={gameStats}
                  awayTeam={awayTeam}
                  homeTeam={homeTeam}
                />
              ) : (
                <div className="flex items-center justify-center h-32 text-text-tertiary text-base">
                  스탯 정보가 없습니다
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ===== ESPN-style sections ===== */}
      <div className="px-4 pb-8 space-y-4">
        {/* Team comparison */}
        <TeamComparisonBar
          awayColor={awayTeam.colorLight}
          homeColor={homeTeam.colorLight}
          awayName={awayTeam.shortName}
          homeName={homeTeam.shortName}
          stats={[
            { label: "안타(H)", awayValue: 8, homeValue: 11 },
            { label: "홈런(HR)", awayValue: 1, homeValue: 2 },
            { label: "볼넷(BB)", awayValue: 3, homeValue: 5 },
            { label: "삼진(SO)", awayValue: 7, homeValue: 4 },
            { label: "잔루(LOB)", awayValue: 6, homeValue: 8 },
            { label: "루타(TB)", awayValue: 12, homeValue: 18 },
          ]}
        />

        {/* Decision pitchers */}
        <GameDecisionPitchers pitchers={[
          { name: "임찬규", teamId: homeTeam.id, role: "WIN", record: "10-3", era: "2.89" },
          { name: "곽빈", teamId: awayTeam.id, role: "LOSS", record: "7-8", era: "4.12" },
          { name: "고우석", teamId: homeTeam.id, role: "SAVE", record: "2-1", era: "1.85" },
        ]} />

        {/* Stadium info */}
        <StadiumInfo
          name="잠실야구장"
          location="서울 송파구"
          capacity="25,553"
          gameTime="3시간 12분"
          attendance="23,847"
          umpires={[
            { role: "주심", name: "김태영" },
            { role: "1루", name: "박성호" },
            { role: "2루", name: "이민호" },
            { role: "3루", name: "최재용" },
          ]}
        />
      </div>
    </div>
  );
}
