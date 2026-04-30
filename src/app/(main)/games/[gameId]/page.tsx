"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { clsx } from "clsx";
import { getTeamById } from "@/lib/constants/teams";
import { getMyTeamId } from "@/lib/store/myteam";
import { useCelebration } from "@/lib/hooks/useCelebration";
import CelebrationOverlay from "@/components/game/CelebrationOverlay";
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
import { generateEvents, type PrevGameState } from "@/lib/event-generator";
import type { LineupEntry } from "@/lib/hooks/useGameDetail";
import { deriveGameState } from "@/lib/utils/game-derived";
import GameDetailHeader from "@/components/game/GameDetailHeader";
import NonLiveScoreDisplay from "@/components/game/NonLiveScoreDisplay";
import ScoreBar from "@/components/game/ScoreBar";
import LinescoreTable from "@/components/game/LinescoreTable";
import FieldViewV2 from "@/components/game/FieldViewV2";
import MatchupCard from "@/components/game/MatchupCard";
import Diamond from "@/components/game/Diamond";
import { ChevronUp, ChevronDown } from "lucide-react";
import ScoreBoard from "@/components/game/ScoreBoard";
import KgwanTab from "@/components/game/KgwanTab";
import LineupTab from "@/components/game/LineupTab";
import GameStatsTab from "@/components/game/GameStatsTab";
import LiveStatsTab from "@/components/game/LiveStatsTab";
import { useGameRelay } from "@/lib/hooks/useGameRelay";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";
import PullToRefresh from "@/components/PullToRefresh";

type Tab = "kgwan" | "lineup" | "stats";

const TABS: { id: Tab; label: string }[] = [
  { id: "kgwan", label: "크관" },
  { id: "lineup", label: "라인업" },
  { id: "stats", label: "기록" },
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
    time: "",
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

function CancelledTabCard() {
  return (
    <div className="px-5 py-6">
      <div className="glass-card p-5 text-center space-y-3">
        <p className="text-base font-bold text-text-primary">경기가 취소되었습니다</p>
        <p className="text-sm text-text-tertiary">우천 등 경기 운영 사유로 취소된 경기입니다.</p>
      </div>
    </div>
  );
}

export default function GameDetailPage() {
  const params = useParams();
  const gameId = params.gameId as string;
  const [activeTab, setActiveTab] = useState<Tab>("kgwan");
  const [isFieldCollapsed, setIsFieldCollapsed] = useState(false);
  const { game: liveGame, refetch: refetchLive } = useLiveGame(gameId, 10000);
  const { data: gameDetail, refetch: refetchDetail } = useGameDetail(gameId, 30000);
  const liveIsFinal = !!liveGame && !liveGame.isLive && (liveGame.awayScore > 0 || liveGame.homeScore > 0);
  // Keep game-events polling through the live → final transition so game_end/victory can be emitted.
  const shouldPollGameEvents = (liveGame?.isLive ?? false) || liveIsFinal;
  const { events: gameEvents } = useGameEvents(gameId, shouldPollGameEvents, 15000);
  const { data: gameRelay } = useGameRelay(gameId, liveGame?.isLive ?? false, 30000, liveGame?.inning ?? 0, liveIsFinal);
  const clientEventStateRef = useRef<PrevGameState | null>(null);

  // Compute game early (non-hook) so celebration hook can reference team IDs
  const game = getGameById(gameId) ?? getPreseasonGameById(gameId) ?? parseKboGameId(gameId);

  // Celebration overlay for homerun events
  const myTeamIdForCelebration = getMyTeamId();
  const { celebration, processEvents, dismiss } = useCelebration({
    myTeamId: myTeamIdForCelebration,
    homeTeamId: game?.homeTeamId ?? 0,
    awayTeamId: game?.awayTeamId ?? 0,
  });

  useEffect(() => {
    if (gameEvents.length > 0) {
      processEvents(gameEvents);
    }
  }, [gameEvents, processEvents]);

  // Serverless memory cannot be trusted to diff live game events consistently.
  // Keep a per-device baseline as well so the actual user's device can trigger celebrations
  // from live + box score changes while they are on the game page.
  useEffect(() => {
    if (!liveGame || !shouldPollGameEvents) return;

    const prevBS = clientEventStateRef.current?.boxScore;
    const currBS = gameDetail?.boxScore ?? null;
    // [DEBUG] temporary — trace client-side diff
    console.log("[client-diff]", {
      hasPrev: !!clientEventStateRef.current,
      prevBS: !!prevBS,
      currBS: !!currBS,
      inning: liveGame.inning,
      isTop: liveGame.isTop,
      score: `${liveGame.awayScore}-${liveGame.homeScore}`,
    });

    const { events: clientEvents, nextState } = generateEvents(
      gameId,
      clientEventStateRef.current,
      liveGame,
      currBS,
    );
    clientEventStateRef.current = nextState;

    if (clientEvents.length > 0) {
      console.log("[client-diff] events:", clientEvents.map(e => `${e.type}(${e.detail?.batter || e.detail?.pitcher || ""})`));
      processEvents(clientEvents);
    }
  }, [gameId, liveGame, gameDetail?.boxScore, shouldPollGameEvents, processEvents]);

  useEffect(() => {
    clientEventStateRef.current = null;
  }, [gameId]);

  // useCallback must be called before any early returns (React hooks rules)
  const handleRefresh = useCallback(async () => {
    await Promise.all([refetchLive(), refetchDetail()]);
  }, [refetchLive, refetchDetail]);
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
  // BoxScore가 유효하려면 타자 + 투수 모두 있어야 함
  // 라이브 중 KBO API가 타자만 채우고 투수는 비어있는 반쪽 상태 방지
  const hasBoxScoreData = gameDetail?.boxScore &&
    (gameDetail.boxScore.awayBatters.length > 0 || gameDetail.boxScore.homeBatters.length > 0) &&
    (gameDetail.boxScore.awayPitchers.length > 0 || gameDetail.boxScore.homePitchers.length > 0);
  const gameStats = staticGameStats ?? (hasBoxScoreData
    ? boxScoreToGameStats(gameId, gameDetail.boxScore!, game.awayTeamId, game.homeTeamId)
    : null);

  const isTopInning = game.inning?.includes("초");
  const battingTeamColor = isTopInning
    ? awayTeam.colorPrimary
    : homeTeam.colorPrimary;

  // 탭 인디케이터: 지정팀 참여시 지정팀 컬러, 아니면 홈팀 컬러
  const myTeamId = getMyTeamId();
  const myTeamInGame = myTeamId && (myTeamId === game.homeTeamId || myTeamId === game.awayTeamId);
  const tabIndicatorTeam = myTeamInGame ? getTeamById(myTeamId)! : homeTeam;

  const d = deriveGameState(liveGame, game, gameDetail);

  return (
    <PullToRefresh
      onRefresh={handleRefresh}
      className="flex flex-col min-h-[100dvh] bg-bg-primary overflow-y-auto pb-[104px] max-w-[640px] mx-auto w-full"
    >
      <GameDetailHeader
        status={d.derivedStatus}
        time={gameDetail?.meta?.startTime || liveGame?.time || game.time}
        stadium={gameDetail?.meta?.stadium || liveGame?.stadium || game.stadium}
      />

      {d.derivedStatus === "cancelled" ? (
        <div className="px-5 py-5">
          <div className="rounded-2xl border border-border bg-bg-secondary px-4 py-5 text-center">
            <p className="text-base font-semibold text-text-primary">경기가 취소되었습니다</p>
            <p className="text-sm text-text-tertiary mt-1">우천 등 경기 운영 사유로 정상 진행되지 않았습니다.</p>
          </div>
        </div>
      ) : d.isLive ? (
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

      {/* Collapsible field area — toggle only visible during live + 크관 tab */}
      {d.isLive && activeTab === "kgwan" && (
        <button
          onClick={() => setIsFieldCollapsed((v) => !v)}
          className="flex items-center justify-center gap-1 w-full py-1.5 text-xs text-text-tertiary active:bg-bg-tertiary transition-colors"
        >
          {isFieldCollapsed ? "중계화면 펼치기" : "중계화면 접기"}
          {isFieldCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      )}

      <motion.div
        animate={{ height: isFieldCollapsed && d.isLive && activeTab === "kgwan" ? 0 : "auto", opacity: isFieldCollapsed && d.isLive && activeTab === "kgwan" ? 0 : 1 }}
        transition={{ duration: 0.25, ease: "easeInOut" }}
        style={{ overflow: "hidden" }}
      >
        {(gameDetail?.linescore || gameRelay?.linescore || innings.length > 0) && (
          <LinescoreTable
            awayTeam={awayTeam}
            homeTeam={homeTeam}
            innings={innings}
            awayScore={d.awayScore}
            homeScore={d.homeScore}
            currentInning={d.currentInning}
            linescore={gameDetail?.linescore ?? gameRelay?.linescore}
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
            relayMatchup={gameRelay?.matchup}
          />
        )}
      </motion.div>

      {!d.isLive && innings.length === 0 && game.status === "final" && (
        <div className="px-5 pb-2">
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

      {/* Tabs */}
      <div className="flex border-b border-border mx-4">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={clsx(
              "flex-1 py-2.5 text-sm font-medium transition-colors relative",
              activeTab === tab.id ? "text-text-primary font-semibold" : "text-text-tertiary"
            )}
          >
            {tab.label}
            {activeTab === tab.id && (
              <motion.div
                layoutId="tab-indicator"
                className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full"
                style={{ backgroundColor: tabIndicatorTeam.colorLight }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
              />
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1">
        <AnimatePresence mode="wait">
          {activeTab === "kgwan" && (
            <motion.div key="kgwan" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
              <KgwanTab
                gameId={gameId}
                homeTeamId={game.homeTeamId}
                awayTeamId={game.awayTeamId}
                status={d.derivedStatus}
                gameEvents={gameEvents}
                plays={plays}
                teamColor={battingTeamColor}
                boxScore={gameDetail?.boxScore ?? null}
                linescore={gameDetail?.linescore ?? gameRelay?.linescore ?? null}
                starterNames={{
                  away: liveGame?.awayStarterName || (gameDetail?.boxScore?.awayPitchers?.[0]?.name && !/^선수\(\d+\)$/.test(gameDetail.boxScore.awayPitchers[0].name) ? gameDetail.boxScore.awayPitchers[0].name : ""),
                  home: liveGame?.homeStarterName || (gameDetail?.boxScore?.homePitchers?.[0]?.name && !/^선수\(\d+\)$/.test(gameDetail.boxScore.homePitchers[0].name) ? gameDetail.boxScore.homePitchers[0].name : ""),
                }}
                lineupConfirmed={!!d.detailLineup && d.detailLineup.isToday === true}
                gameRelay={gameRelay}
              />
            </motion.div>
          )}
          {activeTab === "lineup" && (
            <motion.div key="lineup" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              {d.derivedStatus === "cancelled" ? (
                <CancelledTabCard />
              ) : (d.detailLineup && d.detailLineup.isToday === true) ? (
                <LineupTab
                  gameId={gameId}
                  lineup={{
                    gameId,
                    away: {
                      teamId: game.awayTeamId,
                      startingPitcher: (() => {
                        const boxName = gameDetail?.boxScore?.awayPitchers?.[0]?.name;
                        const validBoxName = boxName && !/^선수\(\d+\)$/.test(boxName) ? boxName : "";
                        const spName = validBoxName || liveGame?.awayStarterName || "";
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
                        const boxName = gameDetail?.boxScore?.homePitchers?.[0]?.name;
                        const validBoxName = boxName && !/^선수\(\d+\)$/.test(boxName) ? boxName : "";
                        const spName = validBoxName || liveGame?.homeStarterName || "";
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
                  isLineupConfirmed={true}
                />
              ) : (
                <div className="flex flex-col items-center justify-center h-32 gap-2">
                  <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
                    <span className="text-yellow-400 text-sm">⚠️</span>
                    <span className="text-sm text-yellow-400/90">
                      라인업 확정 후 공개됩니다.
                    </span>
                  </div>
                </div>
              )}
            </motion.div>
          )}
          {activeTab === "stats" && (
            <motion.div key="stats" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              {d.derivedStatus === "cancelled" ? (
                <CancelledTabCard />
              ) : gameStats ? (
                <GameStatsTab stats={gameStats} awayTeam={awayTeam} homeTeam={homeTeam} relay={gameRelay} />
              ) : liveGame?.isLive && gameRelay && gameRelay.innings.length > 0 ? (
                <LiveStatsTab
                  relay={gameRelay}
                  awayTeam={awayTeam}
                  homeTeam={homeTeam}
                  currentPitcher={d.currentPitcher}
                  awayStarterName={liveGame?.awayStarterName || ""}
                  homeStarterName={liveGame?.homeStarterName || ""}
                />
              ) : (
                <div className="flex flex-col items-center justify-center h-32 gap-2">
                  <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
                    <span className="text-yellow-400 text-sm">&#9888;&#65039;</span>
                    <span className="text-sm text-yellow-400/90">
                      {liveGame?.isLive
                        ? "경기 진행 중입니다. 기록은 경기 종료 후 업데이트됩니다."
                        : d.isFinal
                        ? "경기 상세 데이터 준비 중입니다."
                        : (gameDetail?.meta?.startTime || liveGame?.time || game.time)
                        ? `${gameDetail?.meta?.startTime || liveGame?.time || game.time} 경기 시작 후 확인하실 수 있습니다.`
                        : "경기가 시작된 후 확인하실 수 있습니다."}
                    </span>
                  </div>
                  {d.isFinal && (
                    <button
                      onClick={handleRefresh}
                      className="mt-2 px-4 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-sm text-text-secondary transition-colors"
                    >
                      🔄 새로고침
                    </button>
                  )}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {/* Celebration overlay (homerun etc.) */}
      <CelebrationOverlay event={celebration} onDone={dismiss} />
    </PullToRefresh>
  );
}
