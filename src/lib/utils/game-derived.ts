import type { GameDetailResponse, LineupEntry, PitcherRecord, BatterRecord } from "@/lib/hooks/useGameDetail";
import type { LiveGameData } from "@/lib/hooks/useLiveGame";

interface GameBase {
  inning?: string | null;
  awayScore: number;
  homeScore: number;
  status: string;
  awayTeamId?: number;
  homeTeamId?: number;
}

// Convert LineupEntry[] to the shape FieldViewV2 expects
function toDefenders(entries: LineupEntry[], teamId?: number) {
  return entries.map(e => ({
    order: e.order,
    name: e.name,
    position: e.position,
    avg: "",
    teamId,
  }));
}

/**
 * 타순 번호로 현재 그 자리에 있는 선수 이름을 해결한다.
 * KBO 라이브 API는 베이스 점유를 *타순 번호*로만 알려주므로 대타/대주자 교체가
 * 일어나면 선발 라인업 룩업으로는 잘못된 이름이 나온다. BoxScore는 교체 이력을
 * 포함하니까 *같은 타순의 마지막 entry* = 현재 그 자리 선수로 본다.
 * 초(top)일 때 공격팀은 원정(away), 말(bottom)일 때 공격팀은 홈(home).
 */
function resolveRunnerName(
  orderNo: number | undefined,
  isTop: boolean,
  lineup: GameDetailResponse["lineup"] | null,
  boxScore: GameDetailResponse["boxScore"] | null,
): string | null {
  if (!orderNo || orderNo <= 0) return null;

  // 1) BoxScore 우선 — 교체 이력 반영. 같은 order의 마지막 entry가 현재 주자.
  if (boxScore) {
    const batters = isTop ? boxScore.awayBatters : boxScore.homeBatters;
    for (let i = batters.length - 1; i >= 0; i--) {
      if (batters[i].order === orderNo && batters[i].name) return batters[i].name;
    }
  }

  // 2) 선발 라인업 fallback — BoxScore 미수신 또는 비어있을 때.
  if (lineup) {
    const batters = isTop ? lineup.away : lineup.home;
    const found = batters.find(b => b.order === orderNo);
    if (found?.name) return found.name;
  }

  return null;
}

export function deriveGameState(
  liveGame: LiveGameData | undefined,
  game: GameBase,
  gameDetail: GameDetailResponse | null,
) {
  const currentBalls = liveGame?.balls ?? 0;
  const currentStrikes = liveGame?.strikes ?? 0;
  const currentOuts = liveGame?.outs ?? 0;
  const currentRunner1b = liveGame?.runner1b ?? false;
  const currentRunner2b = liveGame?.runner2b ?? false;
  const currentRunner3b = liveGame?.runner3b ?? false;
  const currentBatter = liveGame?.currentBatter ?? null;
  const currentPitcher = liveGame?.currentPitcher ?? null;
  const currentInning = liveGame?.currentInning || game.inning || "";
  // 점수 소스 우선순위: liveGame > gameDetail linescore > game (static)
  const awayScore = liveGame?.awayScore ?? gameDetail?.linescore?.away?.R ?? game.awayScore;
  const homeScore = liveGame?.homeScore ?? gameDetail?.linescore?.home?.R ?? game.homeScore;
  const isLive = liveGame?.isLive || game.status === "live";
  // liveGame이 있지만 isLive가 false이고 점수가 있으면 → 종료된 경기
  // gameDetail.status도 체크 (과거 경기는 game-live에 없지만 game-detail API는 final 반환)
  const isCancelled = game.status === "cancelled" || gameDetail?.status === "cancelled";
  const isFinal = game.status === "final"
    || gameDetail?.status === "final"
    || (!!liveGame && !liveGame.isLive && (liveGame.awayScore > 0 || liveGame.homeScore > 0));
  const derivedStatus: "live" | "final" | "scheduled" | "cancelled" = isLive ? "live" : isCancelled ? "cancelled" : isFinal ? "final" : "scheduled";

  const isTop = currentInning.includes("초");
  const detailLineup = gameDetail?.lineup ?? null;
  const detailBoxScore = gameDetail?.boxScore ?? null;
  const defensiveTeamId = isTop ? game.homeTeamId : game.awayTeamId;
  const battingTeamId = isTop ? game.awayTeamId : game.homeTeamId;

  const defensiveSide = detailLineup
    ? (isTop ? toDefenders(detailLineup.home, game.homeTeamId) : toDefenders(detailLineup.away, game.awayTeamId))
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

  return {
    currentBalls,
    currentStrikes,
    currentOuts,
    currentRunner1b,
    currentRunner2b,
    currentRunner3b,
    currentBatter,
    currentPitcher,
    currentInning,
    awayScore,
    homeScore,
    isLive,
    isCancelled,
    isFinal,
    derivedStatus,
    isTop,
    detailLineup,
    defensiveSide,
    defensiveTeamId,
    battingTeamId,
    currentPitcherTeamId: defensiveTeamId,
    currentBatterTeamId: battingTeamId,
    runnerTeamId: battingTeamId,
    onDeckBatters,
    pitcherToday,
    batterToday,
    pitcherEra: pitcherToday?.era,
    batterAvg: batterToday?.avg,
    runner1bName: liveGame?.runner1bName || resolveRunnerName(liveGame?.runner1bOrder, isTop, detailLineup, detailBoxScore),
    runner2bName: liveGame?.runner2bName || resolveRunnerName(liveGame?.runner2bOrder, isTop, detailLineup, detailBoxScore),
    runner3bName: liveGame?.runner3bName || resolveRunnerName(liveGame?.runner3bOrder, isTop, detailLineup, detailBoxScore),
  };
}
