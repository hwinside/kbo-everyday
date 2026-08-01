import type { KboRawGame } from "@/types/api";
import { parseKboGameListPayload } from "@/lib/notifications/widget-fast-loop";
import { fetchNaverGames } from "@/lib/crawler/naver-games";
import type { KboGame } from "@/lib/crawler/kbo-api";
import { naverGameId } from "@/lib/crawler/naver-record";

const KBO_MAIN = "https://www.koreabaseball.com/ws/Main.asmx";
const KBO_BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export const NAVER_UNKNOWN_RUNNER_ORDER = 99;
const KBO_PRIMARY_BUDGET_MS = 1_500;
const SOURCE_SETTLE_RESERVE_MS = 100;

async function runSourceBeforeDeadline<T>(
  task: (signal: AbortSignal) => Promise<T>,
  deadlineAtMs: number,
): Promise<T> {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= SOURCE_SETTLE_RESERVE_MS) {
    throw new Error("live_games_settle_budget_exhausted");
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("live games source deadline", "AbortError")),
    remainingMs - SOURCE_SETTLE_RESERVE_MS,
  );
  try {
    // Await the raw operation itself. A Promise.race deadline wrapper can
    // reject while fetch/PostgREST abort cleanup remains active.
    return await task(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export type LiveGamesSource = "kbo" | "naver" | "none";

export type LiveGamesTrace = {
  source: LiveGamesSource;
  stage: "kbo" | "kbo-empty-confirmed" | "naver" | "dual-fail";
  sourceAtMs: number;
  fetchedAtMs: number;
  deadlineAtMs: number;
};

type NaverLiveEvidence = {
  hasRealPlay: boolean;
  balls: number;
  strikes: number;
  outs: number;
  runner1b: boolean;
  runner2b: boolean;
  runner3b: boolean;
  runner1bOrder: number;
  runner2bOrder: number;
  runner3bOrder: number;
  /** relay currentGameState pitcher/batter pcode → 라인업 이름 해석(실패 시 ""). */
  currentPitcher: string;
  currentBatter: string;
};

type NaverLiveEvidenceFetcher = (
  gameId: string,
  signal: AbortSignal,
) => Promise<NaverLiveEvidence>;

function safeCount(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function naverRunnerOrder(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return 0;
  return parsed <= 9 ? parsed : NAVER_UNKNOWN_RUNNER_ORDER;
}

type NaverRelayLineupSide = {
  batter?: Array<{ pcode?: unknown; name?: unknown }>;
  pitcher?: Array<{ pcode?: unknown; name?: unknown }>;
};

/**
 * Naver schedule의 STARTED는 첫 투구 전에도 1회초 0:0으로 바뀐다.
 * relay에 실제 투구 식별자/투구번호가 생긴 뒤에만 downstream live로 노출한다.
 *
 * inning=1 요청이어도 top-level textRelayData.currentGameState 는 항상 "지금" 상태
 * (볼카운트·주자·현재 투수/타자 pcode)를 담고(2026-07-30 4회초 경기 inning=1 실측),
 * awayLineup/homeLineup 에서 pcode→이름을 해석할 수 있어 한 번의 호출로
 * 첫 투구 검증 + live 카운트/매치업 enrichment 를 모두 처리한다.
 */
export async function fetchNaverLiveEvidence(
  gameId: string,
  signal: AbortSignal,
): Promise<NaverLiveEvidence> {
  const response = await fetch(
    `https://api-gw.sports.naver.com/schedule/games/${naverGameId(gameId)}/relay?inning=1`,
    {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)" },
      cache: "no-store",
      signal,
    },
  );
  if (!response.ok) throw new Error(`Naver relay HTTP ${response.status}`);
  const json = await response.json();
  const relayData = json?.result?.textRelayData ?? {};
  const relays = Array.isArray(relayData.textRelays) ? relayData.textRelays : [];
  const options = relays.flatMap((relay: { textOptions?: unknown[] }) =>
    Array.isArray(relay?.textOptions) ? relay.textOptions : []
  ) as Array<{
    seqno?: number;
    pitchNum?: number;
    ptsPitchId?: string;
    currentGameState?: Record<string, unknown>;
  }>;
  const actualPlay = options
    .filter((option) => (
      (typeof option.pitchNum === "number" && option.pitchNum > 0)
      || (typeof option.ptsPitchId === "string" && option.ptsPitchId.length > 0)
    ))
    .sort((a, b) => (b.seqno ?? 0) - (a.seqno ?? 0));
  // 현재 상태는 top-level currentGameState 우선(가장 최신), 없으면 최신 투구 옵션의 것.
  const state = (
    relayData.currentGameState ?? actualPlay[0]?.currentGameState ?? {}
  ) as Record<string, unknown>;
  const roster: Array<{ pcode?: unknown; name?: unknown }> = [];
  for (const side of [relayData.awayLineup, relayData.homeLineup] as Array<NaverRelayLineupSide | undefined>) {
    if (Array.isArray(side?.batter)) roster.push(...side.batter);
    if (Array.isArray(side?.pitcher)) roster.push(...side.pitcher);
  }
  const nameByPcode = (pcode: unknown): string => {
    const key = String(pcode ?? "").trim();
    if (!key || key === "0") return "";
    const hit = roster.find((p) => String(p?.pcode ?? "").trim() === key);
    return typeof hit?.name === "string" ? hit.name.trim() : "";
  };
  const runner1bOrder = naverRunnerOrder(state.base1);
  const runner2bOrder = naverRunnerOrder(state.base2);
  const runner3bOrder = naverRunnerOrder(state.base3);
  return {
    hasRealPlay: actualPlay.length > 0,
    balls: safeCount(state.ball),
    strikes: safeCount(state.strike),
    outs: safeCount(state.out),
    runner1b: runner1bOrder > 0,
    runner2b: runner2bOrder > 0,
    runner3b: runner3bOrder > 0,
    runner1bOrder,
    runner2bOrder,
    runner3bOrder,
    currentPitcher: nameByPcode(state.pitcher),
    currentBatter: nameByPcode(state.batter),
  };
}

function hasSchedulePlayEvidence(game: KboGame): boolean {
  if (game.status !== "live") return true;
  return (
    game.inning > 1
    || !game.isTop
    || (game.awayScore ?? 0) > 0
    || (game.homeScore ?? 0) > 0
  );
}

export function naverGameToRaw(game: KboGame): KboRawGame {
  const state = game.status === "live"
    ? "2"
    : game.status === "final"
      ? "3"
      : game.status === "cancelled"
        ? "4"
        : "1";
  return {
    G_ID: game.gameId,
    G_DT: game.date,
    G_TM: game.time,
    S_NM: game.stadium,
    AWAY_ID: game.gameId.slice(8, 10),
    HOME_ID: game.gameId.slice(10, 12),
    AWAY_NM: game.awayName,
    HOME_NM: game.homeName,
    T_SCORE_CN: game.awayScore == null ? "" : String(game.awayScore),
    B_SCORE_CN: game.homeScore == null ? "" : String(game.homeScore),
    GAME_INN_NO: game.inning,
    GAME_TB_SC: game.isTop ? "T" : "B",
    GAME_STATE_SC: state,
    CANCEL_SC_ID: game.status === "cancelled" ? "1" : "0",
    T_PIT_P_NM: game.awayStarterName,
    B_PIT_P_NM: game.homeStarterName,
    W_PIT_P_NM: game.winPitcher,
    L_PIT_P_NM: game.losePitcher,
    SV_PIT_P_NM: game.savePitcher,
    STRIKE_CN: game.strikes,
    BALL_CN: game.balls,
    OUT_CN: game.outs,
    B1_BAT_ORDER_NO: game.runnerOrders?.first
      ?? (game.runnersOn.first ? NAVER_UNKNOWN_RUNNER_ORDER : 0),
    B2_BAT_ORDER_NO: game.runnerOrders?.second
      ?? (game.runnersOn.second ? NAVER_UNKNOWN_RUNNER_ORDER : 0),
    B3_BAT_ORDER_NO: game.runnerOrders?.third
      ?? (game.runnersOn.third ? NAVER_UNKNOWN_RUNNER_ORDER : 0),
    B_P_NM: game.isTop ? game.currentPitcher : game.currentBatter,
    T_P_NM: game.isTop ? game.currentBatter : game.currentPitcher,
    T_RANK_NO: game.awayRank,
    B_RANK_NO: game.homeRank,
  };
}

/**
 * 서버 알림/Live Activity용 라이브 스코어보드.
 * KBO를 짧게 시도한 뒤 HTTP/network/schema 실패면 남은 deadline 안에서 Naver로
 * failover한다. 두 소스 모두 실패한 ok:false는 정상 "경기 0"과 구분한다.
 */
export async function fetchKboLiveGames(
  date: string,
  deadlineAtMs?: number,
  fetchImpl: typeof fetch = fetch,
  fetchNaverImpl: typeof fetchNaverGames = fetchNaverGames,
  fetchNaverEvidenceImpl: NaverLiveEvidenceFetcher = fetchNaverLiveEvidence,
  requiredGameId?: string,
): Promise<{
  ok: boolean;
  games: KboRawGame[];
  trace: LiveGamesTrace;
}> {
  const sourceAtMs = Date.now();
  const absoluteDeadlineAtMs = deadlineAtMs ?? sourceAtMs + 5_000;
  // KBO 200 + 빈 game 배열(soft-empty)은 장애 중 "가짜 무경기"일 수 있어 Naver 교차확인
  // 전까지 authoritative 로 인정하지 않는다(삼순 2차 리뷰 P1).
  let kboEmptyResult: {
    ok: true;
    games: KboRawGame[];
    trace: LiveGamesTrace;
  } | null = null;
  try {
    const kboDeadlineAtMs = Math.min(
        absoluteDeadlineAtMs,
      Date.now() + KBO_PRIMARY_BUDGET_MS,
    );
    const result = await runSourceBeforeDeadline(
      async (signal) => {
        const response = await fetchImpl(`${KBO_MAIN}/GetKboGameList`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": KBO_BROWSER_UA,
            "Referer": "https://www.koreabaseball.com/Schedule/ScoreBoard.aspx",
          },
          body: `leId=1&srId=0,1,3,4,5,7,8,9&date=${date}`,
          cache: "no-store",
          signal,
        });
        return {
          response,
          json: response.ok ? await response.json() : null,
        };
      },
      kboDeadlineAtMs,
    );
    if (result.response.ok) {
      const games = parseKboGameListPayload(result.json);
      const fetchedAtMs = Date.now();
      if (
        games !== null
        && games.length > 0
        && (!requiredGameId || games.some(game => game.G_ID === requiredGameId))
      ) {
        return {
          ok: true,
          games,
          trace: {
            source: "kbo",
            stage: "kbo",
            sourceAtMs,
            fetchedAtMs,
            deadlineAtMs: absoluteDeadlineAtMs,
          },
        };
      }
      if (games !== null) {
        // Targeted consumers must not treat "other games exist, requested game absent"
        // as authoritative absence; keep the KBO result only as a fallback after Naver witness.
        kboEmptyResult = {
          ok: true,
          games,
          trace: {
            source: "kbo",
            stage: "kbo-empty-confirmed",
            sourceAtMs,
            fetchedAtMs,
            deadlineAtMs: absoluteDeadlineAtMs,
          },
        };
      }
    }
  } catch {
    // Naver failover below.
  }

  try {
    const games = await runSourceBeforeDeadline(
      (signal) => fetchNaverImpl(date, undefined, { signal }),
      absoluteDeadlineAtMs,
    );
    // KBO empty 는 Naver 도 무경기일 때만 인정. Naver 에 경기가 있으면 KBO soft-empty
    // 로 보고 Naver 결과를 사용한다(서비스 전체 블랙홀 방지).
    if (kboEmptyResult && games.length === 0) return kboEmptyResult;
    const verifiedGames = await Promise.all(games.map(async (game) => {
      if (game.status !== "live") return game;
      // 1회초 0:0(스케줄 증거 없음)만 첫 투구 검증 대상. 그 외 live 는 relay 조회가
      // 실패해도 live 유지(카운트만 zero/empty 유지, per-game fail-soft).
      const needsFirstPitchCheck = !hasSchedulePlayEvidence(game);
      const evidenceRemainingMs = absoluteDeadlineAtMs - Date.now();
      if (evidenceRemainingMs <= 0) {
        return needsFirstPitchCheck ? { ...game, status: "scheduled" as const } : game;
      }
      try {
        const evidence = await runSourceBeforeDeadline(
          (signal) => fetchNaverEvidenceImpl(game.gameId, signal),
          absoluteDeadlineAtMs,
        );
        if (needsFirstPitchCheck && !evidence.hasRealPlay) {
          return { ...game, status: "scheduled" as const };
        }
        // Naver schedule 은 볼카운트/주자/현재 투타를 안 줌 → relay currentGameState 로
        // 모든 live 경기를 보강해 경기방·LA·위젯이 경기 내내 0/0/0 으로 굳는 걸 막는다
        // (삼순 2차 리뷰 P0).
        return {
          ...game,
          balls: evidence.balls,
          strikes: evidence.strikes,
          outs: evidence.outs,
          runnersOn: {
            first: evidence.runner1b,
            second: evidence.runner2b,
            third: evidence.runner3b,
          },
          runnerOrders: {
            first: evidence.runner1bOrder,
            second: evidence.runner2bOrder,
            third: evidence.runner3bOrder,
          },
          currentPitcher: evidence.currentPitcher || game.currentPitcher,
          currentBatter: evidence.currentBatter || game.currentBatter,
        };
      } catch {
        return needsFirstPitchCheck ? { ...game, status: "scheduled" as const } : game;
      }
    }));
    return {
      ok: true,
      games: verifiedGames.map(naverGameToRaw),
      trace: {
        source: "naver",
        stage: "naver",
        sourceAtMs,
        fetchedAtMs: Date.now(),
        deadlineAtMs: absoluteDeadlineAtMs,
      },
    };
  } catch {
    // KBO soft-empty(200+빈 배열)는 Naver가 "실제로 무경기"임을 정상 확인해 준 경우에만
    // authoritative로 인정한다. Naver 확인 자체가 실패하면 dual-source 불확실이므로
    // ok:false fail-close — soft-empty가 검증 없이 정상 무경기로 둔갑해 watchdog이
    // 0경기 blackhole에 빠지는 경로를 차단한다(삼순 3차 리뷰 P0).
    return {
      ok: false,
      games: [],
      trace: {
        source: "none",
        stage: "dual-fail",
        sourceAtMs,
        fetchedAtMs: Date.now(),
        deadlineAtMs: absoluteDeadlineAtMs,
      },
    };
  }
}
