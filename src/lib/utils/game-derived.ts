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

const FIELD_POSITIONS = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"] as const;

/**
 * 필드뷰 수비 다이어그램용 수비수 목록을 만든다.
 *
 * 선발 라인업(detailLineup)만 보면 대타·대주·수비교체 이후 필드 위치가 선발 선수
 * 그대로 남아 "타순/투수는 바뀌는데 수비 위치만 안 바뀜" 버그가 난다.
 * (주자 이름 해결과 동일한 근거 — BoxScore는 교체 이력을 포함한다.)
 *
 * 그래서 각 수비 위치별로 BoxScore에서 *그 포지션을 가진 마지막 선수*(= 현재 그
 * 자리 선수)를 우선 사용하고, BoxScore에 해당 포지션이 없을 때만 선발 라인업으로
 * 폴백한다. BoxScore가 통째로 비어있으면 전부 선발 라인업으로 폴백 → 기존 동작 유지.
 */
function toDefenders(
  boxBatters: BatterRecord[] | null | undefined,
  lineupEntries: LineupEntry[] | null | undefined,
  teamId?: number,
) {
  return FIELD_POSITIONS.flatMap(pos => {
    // 1) BoxScore 우선 — 교체 이력 반영. 같은 포지션의 마지막 entry가 현재 수비수.
    let current: BatterRecord | null = null;
    if (boxBatters) {
      for (const b of boxBatters) {
        if (b.position === pos && b.name) current = b;
      }
    }
    if (current) {
      return [{ order: current.order, name: current.name, position: pos, avg: current.avg ?? "", teamId }];
    }
    // 2) 선발 라인업 폴백 — BoxScore 미수신 또는 해당 포지션 미노출.
    const entry = lineupEntries?.find(e => e.position === pos);
    if (entry) {
      return [{ order: entry.order, name: entry.name, position: pos, avg: "", teamId }];
    }
    return [];
  });
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

  const defensiveLineup = detailLineup ? (isTop ? detailLineup.home : detailLineup.away) : null;
  const defensiveBoxBatters = detailBoxScore ? (isTop ? detailBoxScore.homeBatters : detailBoxScore.awayBatters) : null;
  const defensiveSide = (defensiveLineup || (defensiveBoxBatters && defensiveBoxBatters.length > 0))
    ? toDefenders(defensiveBoxBatters, defensiveLineup, defensiveTeamId)
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
