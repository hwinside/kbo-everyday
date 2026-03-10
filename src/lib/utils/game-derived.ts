import type { GameDetailResponse, LineupEntry, PitcherRecord, BatterRecord } from "@/lib/hooks/useGameDetail";
import type { LiveGameData } from "@/lib/hooks/useLiveGame";

interface GameBase {
  inning?: string | null;
  awayScore: number;
  homeScore: number;
  status: string;
}

// Convert LineupEntry[] to the shape FieldViewV2 expects
function toDefenders(entries: LineupEntry[]) {
  return entries.map(e => ({
    order: e.order,
    name: e.name,
    position: e.position,
    avg: "",
  }));
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
  const awayScore = liveGame?.awayScore ?? game.awayScore;
  const homeScore = liveGame?.homeScore ?? game.homeScore;
  const isLive = liveGame?.isLive || game.status === "live";

  const isTop = currentInning.includes("초");
  const detailLineup = gameDetail?.lineup ?? null;

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
    isTop,
    detailLineup,
    defensiveSide,
    onDeckBatters,
    pitcherToday,
    batterToday,
    pitcherEra: pitcherToday?.era,
    batterAvg: batterToday?.avg,
    runner1bName: liveGame?.runner1bName,
    runner2bName: liveGame?.runner2bName,
    runner3bName: liveGame?.runner3bName,
  };
}
