"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { clsx } from "clsx";
import { getTeamById, ALLSTAR_CODE_TO_ID, isAllStarGameId } from "@/lib/constants/teams";
import { getMyTeamId } from "@/lib/store/myteam";
import { useCelebration } from "@/lib/hooks/useCelebration";
import CelebrationOverlay from "@/components/game/CelebrationOverlay";
import {
  getGameById,
  getInningsForGame,
  getPlaysForGame,
} from "@/lib/constants/games";
import type { GameLineup } from "@/lib/constants/games";
import { getStatsForGame } from "@/lib/constants/game-stats";
import type { GameStats, BatterStat, PitcherStat } from "@/lib/constants/game-stats";
import type { GameDetailResponse } from "@/app/api/game-detail/route";
import { getPreseasonGameById } from "@/lib/constants/preseason-schedule";
import { useLiveGame } from "@/lib/hooks/useLiveGame";
import { startLiveActivity } from "@/lib/native-live-activity";
import { updateGameWidget, setWidgetMyTeam } from "@/lib/capacitor/game-notification";
import { useGameDetail } from "@/lib/hooks/useGameDetail";
import type { PrevGameState } from "@/lib/event-generator";
import { advanceClientGameEventTransition } from "@/lib/client-game-event-transition";
import { generateRelayEvents } from "@/lib/relay-event-generator";
import { latestRelayLine } from "@/lib/notifications/relay-line";
import type { LineupEntry } from "@/lib/hooks/useGameDetail";
import { deriveGameState } from "@/lib/utils/game-derived";
import { cancelReasonDetail } from "@/lib/utils/cancel-reason";
import { shouldKeepCancelledGameChat } from "@/lib/game-chat-visibility";
import GameDetailHeader from "@/components/game/GameDetailHeader";
import BroadcastBadges from "@/components/game/BroadcastBadges";
import LiveActivityUpdateNudge from "@/components/game/LiveActivityUpdateNudge";
import NonLiveScoreDisplay from "@/components/game/NonLiveScoreDisplay";
import ScoreBar from "@/components/game/ScoreBar";
import LinescoreTable from "@/components/game/LinescoreTable";
import FieldViewV2 from "@/components/game/FieldViewV2";
import MatchupCard from "@/components/game/MatchupCard";
import Diamond from "@/components/game/Diamond";
import { ChevronUp, ChevronDown } from "lucide-react";
import ScoreBoard from "@/components/game/ScoreBoard";
import GameChatSlot from "@/components/game/GameChatSlot";
import { useChatRoomHasMessages } from "@/lib/supabase/useChatRoomHasMessages";
import KgwanTab from "@/components/game/KgwanTab";
import LineupTab from "@/components/game/LineupTab";
import AllStarEntryRoster from "@/components/game/AllStarEntryRoster";
import GameStatsTab from "@/components/game/GameStatsTab";
import LiveStatsTab from "@/components/game/LiveStatsTab";
import { useGameRelay } from "@/lib/hooks/useGameRelay";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";
import { resolveLineupStarter } from "@/lib/stats/pitcher-season";
import {
  isLineupStarterProvenanceTrusted,
} from "@/lib/source-snapshot";
import PullToRefresh from "@/components/PullToRefresh";
import PostgameInterviewSection from "@/components/game/PostgameInterviewSection";

type Tab = "kgwan" | "lineup" | "stats";

const TABS: { id: Tab; label: string }[] = [
  { id: "kgwan", label: "크관" },
  { id: "lineup", label: "라인업" },
  { id: "stats", label: "기록" },
];

function CancelledGameChat({
  gameId,
  homeTeamId,
  awayTeamId,
  hasGameProgress,
}: {
  gameId: string;
  homeTeamId: number;
  awayTeamId: number;
  hasGameProgress: boolean;
}) {
  const { hasMessages, loading } = useChatRoomHasMessages(`game:${gameId}`);
  if (loading && !hasGameProgress) return null;
  if (!shouldKeepCancelledGameChat({ hasGameProgress, hasExistingMessages: hasMessages })) return null;

  return <GameChatSlot gameId={gameId} homeTeamId={homeTeamId} awayTeamId={awayTeamId} />;
}

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
      hd: DECISION_MAP[p.decision] === "hold" ? 1 : 0,
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
  ...ALLSTAR_CODE_TO_ID, // 올스타 코드(WE/EA) → 나눔/드림. 없으면 parseKboGameId가 undefined 반환해 "경기를 찾을 수 없습니다"로 뜸.
};

/* 팀 id → KBO 2자 코드 역매핑 (Live Activity 최애팀 강조용). */
const ID_TO_KBO_CODE: Record<number, string> = Object.fromEntries(
  Object.entries(KBO_CODE_TO_ID).map(([code, id]) => [id, code]),
);

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

function parseTabParam(v: string | null): Tab | null {
  return v && TABS.some((t) => t.id === v) ? (v as Tab) : null;
}

export default function GameDetailPage() {
  const params = useParams();
  const gameId = params.gameId as string;
  const searchParams = useSearchParams();
  // 라인업 확정 푸시 딥링크: /games/{id}?tab=lineup → 라인업 탭으로 진입(cold: 초기값 / warm: URL 변경 반영).
  const tabParam = parseTabParam(searchParams.get("tab"));
  const [activeTab, setActiveTab] = useState<Tab>(tabParam ?? "kgwan");
  useEffect(() => {
    if (tabParam) setActiveTab(tabParam);
  }, [tabParam]);
  const [isFieldCollapsed, setIsFieldCollapsed] = useState(false);
  const [multiplexActive, setMultiplexActive] = useState(false);
  const liveHook = useLiveGame(gameId, multiplexActive ? 0 : 10000);
  const detailHook = useGameDetail(gameId, multiplexActive ? 0 : 30000);
  const { game: liveGame, snapshot: liveSnapshot, refetch: refetchLive } = liveHook;
  const { data: gameDetail, snapshot: detailSnapshot, refetch: refetchDetail } = detailHook;
  useEffect(() => {
    setMultiplexActive(liveGame?.isLive === true);
  }, [liveGame?.isLive]);
  // 당겨서 새로고침 시 증가 → KgwanTab 종료 요약이 GET 재조회(오류 카드 stuck 해소). 채팅 등 다른 state 무관.
  const [summaryRefreshEpoch, setSummaryRefreshEpoch] = useState(0);
  const liveIsFinal = !!liveGame && !liveGame.isLive && (liveGame.awayScore > 0 || liveGame.homeScore > 0);
  // live→final 전환까지 client-side diff를 유지해 game_end/victory를 한 번 생성한다.
  const shouldProcessGameEvents = (liveGame?.isLive ?? false) || liveIsFinal;
  // Relay polls 5s while live (celebration trigger source), 30s otherwise
  // (display-only). The 3s cadence keeps the relay-bridged celebration path
  // within ~5s of the actual KBO play (was 5s → worst-case fire lag dropped
  // ~4s); the route caches Naver responses for 2s in-memory so KBO upstream
  // load stays bounded across concurrent viewers.
  const relayPollInterval = liveGame?.isLive ? 3000 : 30000;
  // game-events는 첫 poll/매 15초/final 전환 때 relay와 같은 Edge Request의
  // NDJSON frame으로 받는다. 이벤트 기능·cadence는 유지하면서 별도 client poll을 제거한다.
  const { data: gameRelay, events: gameEvents } = useGameRelay(
    gameId,
    liveGame?.isLive ?? false,
    relayPollInterval,
    liveGame?.inning ?? 0,
    liveIsFinal,
    {
      onLiveFrame: liveHook.ingestExternal,
      onDetailFrame: detailHook.ingestExternal,
    },
  );
  const clientEventStateRef = useRef<PrevGameState | null>(null);

  // Compute game early (non-hook) so celebration hook can reference team IDs
  const game = getGameById(gameId) ?? getPreseasonGameById(gameId) ?? parseKboGameId(gameId);

  // Celebration overlay for homerun events
  const myTeamIdForCelebration = getMyTeamId();
  const { celebration, processEvents, dismiss } = useCelebration({
    gameId,
    myTeamId: myTeamIdForCelebration,
    homeTeamId: game?.homeTeamId ?? 0,
    awayTeamId: game?.awayTeamId ?? 0,
  });

  // 잠금화면 Live Activity (W2): 경기룸에서 라이브 경기일 때 실데이터로 카드를
  // 시작/갱신한다. *오직 최애팀 경기*일 때만 시작 — 방문한 경기(비-최애팀)는 카드를
  // 띄우지 않는다(홈위젯/푸시 카드와 동일하게 최애팀 기준으로 통일, 방문 경기 dependency 제거).
  // iOS 네이티브에서만 동작(웹/Android no-op). 같은 gameId 재호출은 네이티브가 update로
  // 처리(중복 방지). 경기룸을 나가도 카드는 유지(스펙 §5-3 잠금화면 목적, 종료는 W4).
  useEffect(() => {
    if (!liveGame || !liveGame.isLive) return;
    const m = gameId.match(/^(\d{8})([A-Z]{2})([A-Z]{2})(\d)$/);
    // 최애팀 id → KBO 2자 코드 역매핑(강조/컬러 + 최애팀 게이트). 미설정/비참여면 "".
    const myTeamId = getMyTeamId();
    const myTeamCode = myTeamId
      ? ID_TO_KBO_CODE[myTeamId] ?? ""
      : "";
    const awayCode = m?.[2] ?? "";
    const homeCode = m?.[3] ?? "";
    const isMyTeamGame =
      !!myTeamCode && (myTeamCode === awayCode || myTeamCode === homeCode);

    // 방문한 경기가 최애팀 경기일 때만 Live Activity를 시작한다. 비-최애팀 경기룸을
    // 열어도 잠금화면 카드는 생기지 않으며, 서버 푸시로 시작된 최애팀 카드도 밀어내지 않는다.
    if (isMyTeamGame) {
      void startLiveActivity({
        gameId,
        awayTeam: liveGame.awayName,
        homeTeam: liveGame.homeName,
        awayTeamCode: awayCode,
        homeTeamCode: homeCode,
        myTeamCode,
        awayScore: liveGame.awayScore,
        homeScore: liveGame.homeScore,
        inning: liveGame.inning,
        isTopInning: liveGame.isTop,
        balls: liveGame.balls,
        strikes: liveGame.strikes,
        outs: liveGame.outs,
        onFirst: liveGame.runner1b,
        onSecond: liveGame.runner2b,
        onThird: liveGame.runner3b,
        pitcherName: liveGame.currentPitcher ?? "",
        batterName: liveGame.currentBatter ?? "",
        stadium: liveGame.stadium ?? "",
        status: "live",
        // 문자중계 최근 플레이 한 줄(1.0.7+) — 서버 relay-line과 동일 추출(단일 소스).
        // 5s 폴링 gameRelay가 아직 없으면 생략(다음 스코어 변화 때 채워짐).
        lastPlay: latestRelayLine(gameRelay) ?? "",
      });
    }

    // Android 홈/잠금화면 위젯(GameScoreWidget) — *최애팀 경기*일 때만 풀 데이터로 갱신.
    // iOS Live Activity와 동일 데이터(주자/투수/타자 포함). 디바이스 최애팀도 기록해
    // 빈 상태 위젯 배경색까지 최애팀으로 맞춘다. (iOS는 no-op.)
    if (myTeamCode) void setWidgetMyTeam(myTeamCode);
    if (isMyTeamGame) {
      // 공격팀(타자) = isTop ? away : home, 수비팀(투수) = 반대.
      const batterTeam = liveGame.isTop ? awayCode : homeCode;
      const pitcherTeam = liveGame.isTop ? homeCode : awayCode;
      void updateGameWidget({
        myTeam: myTeamCode,
        away: awayCode,
        home: homeCode,
        gameId, // 삼순 재리뷰: 경기룸도 gameId 전달 → 네이티브가 실제 경기전환만 last_play clear(빈 gameId 오clear 방지)
        awayScore: String(liveGame.awayScore),
        homeScore: String(liveGame.homeScore),
        status: `LIVE ${liveGame.inning}`,
        pitcher: liveGame.currentPitcher ?? "",
        pitcherTeam: liveGame.currentPitcher ? pitcherTeam : "",
        batter: liveGame.currentBatter ?? "",
        batterTeam: liveGame.currentBatter ? batterTeam : "",
        outs: String(Math.min(Math.max(liveGame.outs ?? 0, 0), 2)),
        diamond: `${liveGame.runner1b ? 1 : 0}${liveGame.runner2b ? 1 : 0}${liveGame.runner3b ? 1 : 0}`,
      });
    }
    // gameRelay는 의도적 제외 — liveGame(볼카운트 포함) 변화로 이미 자주 재실행되어
    // lastPlay가 그때마다 최신으로 실림. 5s 폴링마다 start 재호출할 이유 없음.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveGame, gameId]);

  // 잠금화면 ongoing notification 카드는 *오직 최애팀 경기*에만 노출하며, 생성·갱신·제거를
  // 전부 *푸시*(C2 game_live/game_end)가 소유한다. 비-최애팀 경기는 카드를 아예 띄우지 않는다.
  // 따라서 경기룸(page)은 카드 생명주기에 일절 관여하지 않는다 — start/removeGameNotification
  // 호출 없음. (이전엔 비-최애팀을 경기룸이 소유했으나 2026-06-12 "오직 최애팀만" 방침으로 제거.)

  // Client-side diff for celebration triggers.
  // Server events (gameEvents) are only used for text relay (KgwanTab), not celebrations,
  // because server event IDs are unstable across Vercel cold starts and cause replay on re-entry.
  const skipNextDiffRef = useRef(false);

  // Merge KBO BoxScore-diff events with Naver-relay events in a SINGLE
  // processEvents batch. Splitting into two useEffects would baseline-seed
  // only the first source that fires; the second source's first response
  // would then replay every historical play as a fresh celebration. The
  // module-level displayedEventIds set inside useCelebration dedupes
  // identical ids across sources, so whichever source observes a play first
  // wins — the relay path typically arrives 10–20s before BoxScore.
  useEffect(() => {
    if (!liveGame || !shouldProcessGameEvents) return;
    const transition = advanceClientGameEventTransition({
      gameId,
      previous: clientEventStateRef.current,
      current: liveGame,
      boxScore: gameDetail?.boxScore ?? null,
      skipNextDiff: skipNextDiffRef.current,
      visibilityState: document.visibilityState,
    });
    clientEventStateRef.current = transition.nextState;
    skipNextDiffRef.current = transition.skipNextDiff;
    if (!transition.shouldProcess) return;

    const relayEvents = generateRelayEvents(gameId, gameRelay?.innings, liveGame);

    const merged = relayEvents.length > 0 || transition.events.length > 0
      ? [...relayEvents, ...transition.events]
      : [];
    if (merged.length > 0) {
      processEvents(merged, { preserveFreshGameEnd: transition.preserveFreshGameEnd });
    }
  }, [gameId, liveGame, gameDetail?.boxScore, gameRelay?.innings, shouldProcessGameEvents, processEvents]);

  // Reset baseline on gameId change
  useEffect(() => {
    clientEventStateRef.current = null;
  }, [gameId]);

  // Reset baseline when app returns from background to prevent stale diff
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        skipNextDiffRef.current = true;
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  // useCallback must be called before any early returns (React hooks rules)
  const handleRefresh = useCallback(async () => {
    // 요약 오류 카드가 pull-refresh 후에도 stuck 되던 문제: epoch 증가로 GET 재조회 유도.
    // live/detail refetch 중 하나가 reject 도 AI요약 재조회는 막히면 안 되므로(동일 stuck),
    // finally 로 epoch bump 를 독립 보장한다.
    try {
      await Promise.all([refetchLive(), refetchDetail()]);
    } finally {
      setSummaryRefreshEpoch((e) => e + 1);
    }
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
  const linescore = gameDetail?.linescore ?? gameRelay?.linescore ?? null;

  const isTopInning = game.inning?.includes("초");
  const battingTeamColor = isTopInning
    ? awayTeam.colorPrimary
    : homeTeam.colorPrimary;

  // 탭 인디케이터: 지정팀 참여시 지정팀 컬러, 아니면 홈팀 컬러
  const myTeamId = getMyTeamId();
  const myTeamInGame = myTeamId && (myTeamId === game.homeTeamId || myTeamId === game.awayTeamId);
  const tabIndicatorTeam = myTeamInGame ? getTeamById(myTeamId)! : homeTeam;

  // gameRelay 교체·수비위치 이벤트를 넘겨 필드뷰 수비 배치를 소스 진실(타임라인) 기반으로 확정한다.
  const d = deriveGameState(liveGame, game, gameDetail, gameRelay?.innings);
  // 두 API의 요청시각은 payload revision이 아니다. live 성공 여부만 전달하고,
  // 불일치 시 confirmed lineup 우선 정책은 resolveLineupStarter가 담당한다.
  const liveStarterFresh = Boolean(liveSnapshot);
  const lineupStarterTrusted = isLineupStarterProvenanceTrusted({
    source: detailSnapshot?.lineupSource,
    awayBatters: d.detailLineup?.away.length ?? 0,
    homeBatters: d.detailLineup?.home.length ?? 0,
    isAllStar: isAllStarGameId(gameId),
  });
  const awayLineupStarter = resolveLineupStarter({
    liveStarterName: liveGame?.awayStarterName,
    lineupStarterName: d.detailLineup?.awayStarter,
    liveStarterFresh,
    lineupStarterTrusted,
    lineupSource: detailSnapshot?.lineupSource,
    teamId: game.awayTeamId,
    boxPitcher: gameDetail?.boxScore?.awayPitchers?.[0],
  });
  const homeLineupStarter = resolveLineupStarter({
    liveStarterName: liveGame?.homeStarterName,
    lineupStarterName: d.detailLineup?.homeStarter,
    liveStarterFresh,
    lineupStarterTrusted,
    lineupSource: detailSnapshot?.lineupSource,
    teamId: game.homeTeamId,
    boxPitcher: gameDetail?.boxScore?.homePitchers?.[0],
  });
  const hasGameProgress = Boolean(
    gameEvents.length > 0
    || gameRelay?.innings.some((inning) => inning.plays.length > 0)
    || /^\d+회(?:초|말)/.test(d.currentInning)
    || d.awayScore > 0
    || d.homeScore > 0
    || hasBoxScoreData
  );

  const matchupTitle = `${awayTeam.shortName} vs ${homeTeam.shortName}`;
  const starterOnlyLineup: GameLineup | null = (() => {
    const awayName = awayLineupStarter.name;
    const homeName = homeLineupStarter.name;
    if (!awayName && !homeName) return null;
    return {
      gameId,
      away: {
        teamId: game.awayTeamId,
        startingPitcher: awayLineupStarter,
        batters: [],
      },
      home: {
        teamId: game.homeTeamId,
        startingPitcher: homeLineupStarter,
        batters: [],
      },
    };
  })();

  return (
    <div className="min-h-[100dvh] bg-bg-primary max-w-[640px] mx-auto w-full">
      {/* 헤더는 스크롤 컨테이너(PullToRefresh) 밖 page-root에 두어 sticky top-0가 페이지 스크롤 기준으로 고정되게 한다 */}
      <GameDetailHeader title={matchupTitle} />

    <PullToRefresh
      onRefresh={handleRefresh}
      className="flex flex-col pb-[104px]"
    >

      {d.derivedStatus === "cancelled" ? (
        <div className="px-5 py-5">
          <div className="rounded-2xl border border-border bg-bg-secondary px-4 py-5 text-center">
            <p className="text-base font-semibold text-text-primary">경기가 취소되었습니다</p>
            {/* 사유를 받았을 때만 원문 노출. 못 받았으면(폴백 경로 등) 기존 고정 문구로 fallback —
                사유 부재를 "사유 없음"으로 단정하지 않는다(provenance 계약). */}
            <p className="text-sm text-text-tertiary mt-1">
              {cancelReasonDetail(d.cancelReason) ?? "우천 등 경기 운영 사유로 정상 진행되지 않았습니다."}
            </p>
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

      {/* 헤더에서 내린 경기 정보줄: 상태(예정/경기 중/종료)·예정 시간·중계 방송사·구장 */}
      {d.derivedStatus !== "cancelled" && (
        <div className="flex w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 px-5 pt-1.5 pb-1 text-[13px] text-text-tertiary">
          {d.derivedStatus === "scheduled" ? (
            <>
              {(gameDetail?.meta?.startTime || liveGame?.time || game.time) && (
                <span>{gameDetail?.meta?.startTime || liveGame?.time || game.time} 예정</span>
              )}
              <BroadcastBadges channels={gameDetail?.meta?.broadcastChannels} />
            </>
          ) : (
            <span>{d.derivedStatus === "live" ? "경기 중" : "경기 종료"}</span>
          )}
          {(gameDetail?.meta?.stadium || liveGame?.stadium || game.stadium) && (
            <span>{gameDetail?.meta?.stadium || liveGame?.stadium || game.stadium}</span>
          )}
        </div>
      )}

      {/* ② 구버전(채널 미지원) iOS 앱 업데이트 녋지 — 라이브 맥락·세션당 1회(LA gap 감축). */}
      <LiveActivityUpdateNudge isLive={d.isLive} />

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
            currentPitcherTeamId={d.currentPitcherTeamId}
            currentBatterTeamId={d.currentBatterTeamId}
            runnerTeamId={d.runnerTeamId}
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
            currentPitcherTeamId={d.currentPitcherTeamId}
            currentBatterTeamId={d.currentBatterTeamId}
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

      <PostgameInterviewSection key={gameId} gameId={gameId} enabled={d.isFinal} />

      {d.derivedStatus === "cancelled" ? (
        <CancelledGameChat
          gameId={gameId}
          homeTeamId={game.homeTeamId}
          awayTeamId={game.awayTeamId}
          hasGameProgress={hasGameProgress}
        />
      ) : (
        <>
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
                    gameDate={game.date}
                    gameStartTime={gameDetail?.meta?.startTime || liveGame?.time || game.time}
                    status={d.derivedStatus}
                    cancelReason={d.cancelReason}
                    gameEvents={gameEvents}
                    plays={plays}
                    teamColor={battingTeamColor}
                    boxScore={gameDetail?.boxScore ?? null}
                    linescore={gameDetail?.linescore ?? gameRelay?.linescore ?? null}
                    refreshEpoch={summaryRefreshEpoch}
                    starterNames={{
                      away: awayLineupStarter.name,
                      home: homeLineupStarter.name,
                    }}
                    lineupConfirmed={!!d.detailLineup && d.detailLineup.isToday === true}
                    gameRelay={gameRelay}
                    currentPitcher={d.currentPitcher}
                    currentBatter={d.currentBatter}
                    balls={d.currentBalls}
                    strikes={d.currentStrikes}
                    outs={d.currentOuts}
                  />
                </motion.div>
              )}
          {activeTab === "lineup" && (
            <motion.div key="lineup" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              {/* 올스타전은 KBO가 LINEUP_CK를 false로 내려 isToday 게이트에 걸림(어제 라인업
                  오표시 방지용 플래그가 올스타엔 미설정). 타순 9+9가 실재하면 표시 —
                  올스타 gameId 조회라 과거 경기 stale 라인업 리스크 없음. */}
              {(d.detailLineup && (d.detailLineup.isToday === true ||
                (isAllStarGameId(gameId) && d.detailLineup.away.length >= 9 && d.detailLineup.home.length >= 9))) ? (
                <LineupTab
                  gameId={gameId}
                  lineup={{
                    gameId,
                    away: {
                      teamId: game.awayTeamId,
                      startingPitcher: awayLineupStarter,
                      batters: d.detailLineup.away.map((e: LineupEntry) => {
                        const roster = PLAYERS_ROSTER.find((p: { name: string; teamId: number; kboId: string }) => p.name === e.name && p.teamId === game.awayTeamId);
                        return { order: e.order, name: e.name, position: e.position, avg: e.avg || "", kboId: roster?.kboId, teamId: game.awayTeamId };
                      }),
                    },
                    home: {
                      teamId: game.homeTeamId,
                      startingPitcher: homeLineupStarter,
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
              ) : starterOnlyLineup ? (
                <LineupTab
                  gameId={gameId}
                  lineup={starterOnlyLineup}
                  awayTeam={awayTeam}
                  homeTeam={homeTeam}
                  isLineupConfirmed={false}
                />
              ) : isAllStarGameId(gameId) ? (
                /* 올스타전: 타순 게시 전엔 확정 엔트리 50명 명단(원소속 팀명 병기) 노출 (2026-07-11 하린아빠) */
                <AllStarEntryRoster />
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
              {gameStats ? (
                <GameStatsTab
                  stats={gameStats}
                  awayTeam={awayTeam}
                  homeTeam={homeTeam}
                  relay={gameRelay}
                  linescore={linescore}
                />
              ) : liveGame?.isLive && gameRelay && gameRelay.innings.length > 0 ? (
                <LiveStatsTab
                  relay={gameRelay}
                  awayTeam={awayTeam}
                  homeTeam={homeTeam}
                  currentPitcher={d.currentPitcher}
                  awayStarterName={liveGame?.awayStarterName || ""}
                  homeStarterName={liveGame?.homeStarterName || ""}
                  linescore={linescore}
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
        </>
      )}
      {/* Celebration overlay (homerun etc.) */}
      <CelebrationOverlay event={celebration} onDone={dismiss} />
    </PullToRefresh>
    </div>
  );
}
