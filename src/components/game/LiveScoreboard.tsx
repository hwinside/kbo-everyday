"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import Diamond from "./Diamond";
import FieldView from "./FieldView";
import CountIndicator from "./CountIndicator";
import type { GameState } from "@/lib/types";
import type { GameLineup } from "@/lib/constants/games";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { resolveRosterPlayer } from "@/lib/utils/player-roster";

interface LiveScoreboardProps {
  gameId: string;
  awayName: string;
  homeName: string;
  awayScore: number;
  homeScore: number;
  awayColor: string;
  homeColor: string;
  currentInning: string;
  state: GameState;
  isLive?: boolean;
  lineup?: GameLineup | null;
}

export default function LiveScoreboard({
  awayName,
  homeName,
  awayScore,
  homeScore,
  awayColor,
  homeColor,
  currentInning,
  state,
  isLive = false,
  lineup,
}: LiveScoreboardProps) {
  const [pulse, setPulse] = useState(false);

  // 점수 변동 시 펄스
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 1000);
    return () => clearTimeout(t);
  }, [awayScore, homeScore]);

  const isTop = currentInning.includes("초");
  const attackingTeam = isTop ? "away" : "home";

  // Get pitcher stats from lineup
  const pitcherSide = isTop ? lineup?.home : lineup?.away;

  // Find batter on the attacking side first. Avoid name-only cross-team matches for 동명이인.
  const batterSide = isTop ? lineup?.away : lineup?.home;
  const currentBatterData = batterSide?.batters.find((b) => b.name === state.currentBatter);

  // Determine pitcher/batter team IDs for photos
  const pitcherTeamId = pitcherSide?.teamId;
  const batterTeamId = batterSide?.teamId;

  // Defensive team is the fielding team
  const defensiveSide = isTop ? lineup?.home : lineup?.away;

  // 투수/타석 슬롯은 역할이 확실하므로 positionHint 로 같은 팀 동명이인(삼성 김태훈 투/야)을 분리한다.
  const pitcherRoster = state.currentPitcher ? resolveRosterPlayer({ name: state.currentPitcher, teamId: pitcherTeamId, positionHint: "투수" }) : null;
  const batterRoster = state.currentBatter ? resolveRosterPlayer({ name: state.currentBatter, teamId: batterTeamId, positionHint: "야수" }) : null;
  const pitcherPhotoUrl = state.currentPitcher
    ? getPlayerPhotoUrl(state.currentPitcher, pitcherRoster?.kboId, pitcherTeamId, "투수")
    : null;
  const batterPhotoUrl = state.currentBatter
    ? getPlayerPhotoUrl(state.currentBatter, batterRoster?.kboId, batterTeamId, "야수")
    : null;

  return (
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-bg-secondary to-bg-tertiary border border-border">
      {/* Live indicator */}
      {isLive && (
        <div className="absolute top-3 right-3 flex items-center gap-1.5">
          <motion.div
            className="w-2 h-2 rounded-full bg-red-500"
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ repeat: Infinity, duration: 1.5 }}
          />
          <span className="text-xs font-bold text-red-400">LIVE</span>
        </div>
      )}

      <div className="px-4 pt-4 pb-3">
        {/* Inning */}
        <div className="text-center mb-3">
          <span className="text-xs font-bold text-accent bg-accent/10 px-3 py-1 rounded-full">
            {currentInning}
          </span>
        </div>

        {/* Score row */}
        <div className="flex items-center justify-center gap-4 mb-3">
          {/* Away */}
          <div className={`text-center flex-1 ${attackingTeam === "away" ? "" : "opacity-60"}`}>
            <p className="text-xs font-bold text-text-tertiary mb-1">{awayName}</p>
            <motion.p
              className="text-4xl font-black tabular-nums"
              style={{ color: awayColor }}
              animate={pulse ? { scale: [1, 1.2, 1] } : {}}
              transition={{ duration: 0.3 }}
            >
              {awayScore}
            </motion.p>
            {attackingTeam === "away" && (
              <motion.div
                className="mt-1 mx-auto w-6 h-0.5 rounded-full"
                style={{ backgroundColor: awayColor }}
                layoutId="attack-bar"
              />
            )}
          </div>

          {/* Small diamond fallback when no lineup */}
          {!defensiveSide && (
            <div className="flex flex-col items-center gap-1">
              <Diamond
                runner1b={state.runner1b}
                runner2b={state.runner2b}
                runner3b={state.runner3b}
                teamColor={attackingTeam === "away" ? awayColor : homeColor}
              />
            </div>
          )}

          {/* Home */}
          <div className={`text-center flex-1 ${attackingTeam === "home" ? "" : "opacity-60"}`}>
            <p className="text-xs font-bold text-text-tertiary mb-1">{homeName}</p>
            <motion.p
              className="text-4xl font-black tabular-nums"
              style={{ color: homeColor }}
              animate={pulse ? { scale: [1, 1.2, 1] } : {}}
              transition={{ duration: 0.3 }}
            >
              {homeScore}
            </motion.p>
            {attackingTeam === "home" && (
              <motion.div
                className="mt-1 mx-auto w-6 h-0.5 rounded-full"
                style={{ backgroundColor: homeColor }}
                layoutId="attack-bar"
              />
            )}
          </div>
        </div>

        {/* Field view with defensive positions */}
        {defensiveSide && (
          <FieldView
            defenders={defensiveSide.batters}
            currentPitcher={state.currentPitcher}
            currentBatter={state.currentBatter}
            runner1b={state.runner1b}
            runner2b={state.runner2b}
            runner3b={state.runner3b}
            runner1bName={state.runner1bName}
            runner2bName={state.runner2bName}
            runner3bName={state.runner3bName}
          />
        )}
      </div>

      {/* BSO + Matchup */}
      <div className="px-4 py-3 border-t border-border bg-black/20">
        <CountIndicator
          balls={state.balls}
          strikes={state.strikes}
          outs={state.outs}
          currentBatter={state.currentBatter}
          currentPitcher={state.currentPitcher}
          pitcherPhotoUrl={pitcherPhotoUrl}
          batterPhotoUrl={batterPhotoUrl}
          pitcherTeamId={pitcherTeamId}
          batterTeamId={batterTeamId}
          pitcherStats={
            pitcherSide
              ? {
                  era: pitcherSide.startingPitcher.era,
                  pitchCount: 72, // mock
                }
              : undefined
          }
          batterStats={
            currentBatterData
              ? {
                  avg: currentBatterData.avg,
                  todayRecord: "2타수 1안타", // mock
                }
              : undefined
          }
        />
      </div>
    </div>
  );
}
