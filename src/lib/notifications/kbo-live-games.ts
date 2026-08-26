import type { KboRawGame } from "@/types/api";
import { parseKboGameListPayload } from "@/lib/notifications/widget-fast-loop";
import { fetchNaverGames } from "@/lib/crawler/naver-games";
import type { KboGame } from "@/lib/crawler/kbo-api";
import { fetchKboGamesOnly } from "@/lib/crawler/kbo-api";
import { naverGameId } from "@/lib/crawler/naver-record";

const KBO_MAIN = "https://www.koreabaseball.com/ws/Main.asmx";
const KBO_BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export const NAVER_UNKNOWN_RUNNER_ORDER = 99;
const KBO_PRIMARY_BUDGET_MS = 1_500;
// Naver-primary 변형(fetchLiveGamesNaverPrimary)에서 Naver schedule 조회에 주는 상한.
// 이 안에 안 끝나면 KBO-primary fallback 이 남은 deadline 을 쓸 수 있게 유계한다.
const NAVER_PRIMARY_BUDGET_MS = 3_000;
// Naver-primary 때 KBO 준정적 필드(선발·승패투·순위) enrich 조회 상한. 비차단·베스트이포트—
// 실패해도 Naver-only 로 진행(선발만 빈 값, 라이브 상태는 Naver 유지).
const KBO_ENRICH_BUDGET_MS = 1_500;
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
  // relay currentGameState 의 점수(homeScore/awayScore) — 중계 한 줄·볼카운트와 같은 relay
  // 피드라 schedule 피드(fetchNaverGames)보다 신선하다. 없으면(첫 투구 전 등) null.
  awayScore: number | null;
  homeScore: number | null;
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

// relay 점수는 없을 수 있으므로 0 대신 null 로 구분(schedule 점수를 0 으로 덮어쓰지 않게).
function safeScoreOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
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
  const topLevelState = (relayData.currentGameState ?? null) as Record<string, unknown> | null;
  const state = (
    topLevelState ?? actualPlay[0]?.currentGameState ?? {}
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
    // 점수는 top-level currentGameState 에서만 취한다(#1311 삼순 B②). actualPlay[0] 폴백은
    // relay?inning=1 의 1회 투구라 8회 경기에 1회 점수(0:0)를 실을 수 있어 점수 override 오염이 된다.
    // top-level 부재 → null → enrich 에서 schedule 점수 유지(count/base/투타는 기존대로 state 폴백 허용).
    awayScore: safeScoreOrNull(topLevelState?.awayScore),
    homeScore: safeScoreOrNull(topLevelState?.homeScore),
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
 * Naver schedule 게임 목록을 relay currentGameState 로 보강해 KboRawGame[] 로 변환한다.
 * - live 경기: 볼카운트/주자/현재 투타를 relay 로 채운다(schedule 은 스코어/이닝만 줌).
 * - 1회초 0:0(스케줄 증거 없음) + relay 에 실제 투구 없음 → scheduled 로 강등(가짜 live 방지).
 * - relay 조회 실패는 per-game fail-soft(그 경기 카운트만 zero/empty, live 유지).
 * fetchKboLiveGames(Naver failover)와 fetchLiveGamesNaverPrimary 가 공유한다.
 */
async function enrichNaverLiveGames(
  games: KboGame[],
  absoluteDeadlineAtMs: number,
  fetchNaverEvidenceImpl: NaverLiveEvidenceFetcher,
  // 점수를 relay(evidence)로 override 할지 — Naver-primary(warmup) 경로만 true(#1311 삼순 P1 스코프).
  // fetchKboLiveGames failover 는 false(기본값) → watchdog·관제 등 공유 소비자는 기존 동작 유지.
  overrideScoreFromRelay = false,
): Promise<KboRawGame[]> {
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
        // 근본 수정(#1311 삼순 근본질문): 점수도 relay(중계·카운트와 같은 신선 top-level 피드)에서 뽑는다.
        // schedule 점수가 relay 보다 느린 구간에서 "중계 최신 + 점수 stale" 재발 방지. relay 점수 부재시 schedule 유지.
        // Naver-primary 경로만 override(공유 failover 경로는 기존대로 schedule 점수 — 삼순 P1 스코프).
        awayScore: overrideScoreFromRelay ? (evidence.awayScore ?? game.awayScore) : game.awayScore,
        homeScore: overrideScoreFromRelay ? (evidence.homeScore ?? game.homeScore) : game.homeScore,
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
  return verifiedGames.map(naverGameToRaw);
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
    const rawGames = await enrichNaverLiveGames(
      games,
      absoluteDeadlineAtMs,
      fetchNaverEvidenceImpl,
    );
    return {
      ok: true,
      games: rawGames,
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

/**
 * Naver primary 게임에 KBO 준정적 필드(선발·승패투·세이브·순위)만 오버레이한다.
 * 이 필드들은 경기 상태와 무관(status-independent)하게 변하지 않아 KBO 값을 썬도 유령 상태
 * 섞임(#1311 B②)이 안 생긴다. 점수·이닝·카운트·주자 등 라이브 축은 Naver 값을 그대로 둔다.
 * Naver 값이 비어있을(선발 미확정 등) 때만 KBO 값으로 채운다 — scheduled 카드가 선발을 잃지 않게.
 */
function overlayKboQuasiStatic(naverBase: KboGame[], kboGames: KboGame[]): KboGame[] {
  const kboById = new Map(kboGames.map((g) => [g.gameId, g]));
  return naverBase.map((base) => {
    const k = kboById.get(base.gameId);
    if (!k) return base;
    // 승/패/세이브 투수는 양쪽 final 일 때만 실는다(games-user-facing 과 동일 규칙 — P2).
    // 선발/순위는 status 무관 준정적 필드라 항상 오버레이.
    const bothFinal = base.status === "final" && k.status === "final";
    return {
      ...base,
      awayStarterName: base.awayStarterName || k.awayStarterName,
      homeStarterName: base.homeStarterName || k.homeStarterName,
      winPitcher: bothFinal ? (base.winPitcher || k.winPitcher) : base.winPitcher,
      losePitcher: bothFinal ? (base.losePitcher || k.losePitcher) : base.losePitcher,
      savePitcher: bothFinal ? (base.savePitcher || k.savePitcher) : base.savePitcher,
      awayRank: base.awayRank || k.awayRank,
      homeRank: base.homeRank || k.homeRank,
    };
  });
}

/**
 * Live Activity 카드·위젯용 Naver-primary 라이브 스코어보드.
 * 앱 화면(games-user-facing)과 동일하게 Naver 를 primary 로 쓴다 — KBO 스코어보드가
 * 200 OK 이면서 점수만 stale 인 구간에서도 카드가 밀리지 않게 한다.
 * (fetchKboLiveGames 는 KBO-primary — KBO 200 이면 Naver 를 아예 안 보므로 soft-lag 에 취약.)
 *
 * 순서: Naver schedule(bounded) → relay evidence 보강 → naverGameToRaw.
 * Naver schedule 이 실패하거나 무경기(빈 배열)면 fetchKboLiveGames(KBO-primary +
 * 자체 Naver failover + soft-empty 교차확인)로 위임한다. 두 소스 모두 실패 ok:false.
 *
 * ⚠️ 이 변형은 warmup cron(LA broadcast·iOS/Android 위젯·점수알림·시작감지) 전용.
 * game-start-watchdog·admin 관제 등 다른 소비자는 fetchKboLiveGames(KBO-primary) 그대로.
 */
export async function fetchLiveGamesNaverPrimary(
  date: string,
  deadlineAtMs?: number,
  fetchImpl: typeof fetch = fetch,
  fetchNaverImpl: typeof fetchNaverGames = fetchNaverGames,
  fetchNaverEvidenceImpl: NaverLiveEvidenceFetcher = fetchNaverLiveEvidence,
  fetchKboGamesImpl: typeof fetchKboGamesOnly = fetchKboGamesOnly,
): Promise<{
  ok: boolean;
  games: KboRawGame[];
  trace: LiveGamesTrace;
}> {
  const sourceAtMs = Date.now();
  const absoluteDeadlineAtMs = deadlineAtMs ?? sourceAtMs + 5_000;
  try {
    const naverDeadlineAtMs = Math.min(
      absoluteDeadlineAtMs,
      Date.now() + NAVER_PRIMARY_BUDGET_MS,
    );
    const kboEnrichDeadlineAtMs = Math.min(
      absoluteDeadlineAtMs,
      Date.now() + KBO_ENRICH_BUDGET_MS,
    );
    // Naver(primary, live 상태) + KBO(준정적 enrich)를 병렬 호출. 앱 games-user-facing 과
    // 동일 철학 — KBO enrich 는 비차단이라 실패해도 Naver-only 로 진행.
    const [naverResult, kboResult] = await Promise.allSettled([
      runSourceBeforeDeadline(
        (signal) => fetchNaverImpl(date, undefined, { signal }),
        naverDeadlineAtMs,
      ),
      runSourceBeforeDeadline(
        (signal) => fetchKboGamesImpl(date, undefined, { signal }),
        kboEnrichDeadlineAtMs,
      ),
    ]);
    // Naver schedule 실패/무경기 → KBO-primary(soft-empty 교차확인 포함)로 위임.
    if (naverResult.status !== "fulfilled" || naverResult.value.length === 0) {
      return fetchKboLiveGames(
        date,
        deadlineAtMs,
        fetchImpl,
        fetchNaverImpl,
        fetchNaverEvidenceImpl,
      );
    }
    const enrichedBase = kboResult.status === "fulfilled"
      ? overlayKboQuasiStatic(naverResult.value, kboResult.value)
      : naverResult.value;
    const rawGames = await enrichNaverLiveGames(
      enrichedBase,
      absoluteDeadlineAtMs,
      fetchNaverEvidenceImpl,
      true, // Naver-primary — 점수도 relay 로 override(warmup 한정 스코프)
    );
    return {
      ok: true,
      games: rawGames,
      trace: {
        source: "naver",
        stage: "naver",
        sourceAtMs,
        fetchedAtMs: Date.now(),
        deadlineAtMs: absoluteDeadlineAtMs,
      },
    };
  } catch {
    // Naver schedule 실패 → KBO-primary fallback(자체 Naver failover 포함).
    return fetchKboLiveGames(
      date,
      deadlineAtMs,
      fetchImpl,
      fetchNaverImpl,
      fetchNaverEvidenceImpl,
    );
  }
}
