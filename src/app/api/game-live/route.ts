import { NextRequest, NextResponse } from "next/server";
import type { KboRawGame } from "@/types/api";
import { resolveCurrentPlayers } from "@/lib/kbo-player-mapping";
import { PLAYER_PHOTO_MAP } from "@/lib/constants/player-photos";
import { resolveGameLiveDate } from "@/lib/game-live-date";
import { parseCancelReason } from "@/lib/crawler/kbo-api";
import { isKboGameCancelled } from "@/lib/crawler/kbo-status";
import { fetchKboLiveGames } from "@/lib/notifications/kbo-live-games";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  NO_STORE_HEADERS,
} from "@/lib/http/live-cache";

const GAME_LIVE_DEADLINE_MS = 5_000;
const SLATE_WITNESS_BUDGET_MS = 250;
const SLATE_SETTLE_RESERVE_MS = 100;

type StarterWitnessGame = {
  gameId: string;
  awayStarterName?: string | null;
  homeStarterName?: string | null;
};

type GameLiveTrace = {
  source: string;
  stage: string;
  sourceAtMs: number;
  fetchedAtMs: number;
  deadlineAtMs: number;
};

type GameLiveRouteDeps = {
  fetchKnownSlateIdsImpl: (
    date: string,
    deadlineAtMs: number,
    signal: AbortSignal,
  ) => Promise<string[]>;
};

async function fetchKnownSlateIds(
  date: string,
  deadlineAtMs: number,
  signal: AbortSignal,
): Promise<string[]> {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) throw new Error("known_slate_deadline");
  // query-guard: bounded -- one KBO date has at most 10 games; 11 detects overflow and fails closed.
  const query = getSupabaseAdmin()
    .from("game_notify_state")
    .select("game_id")
    .like("game_id", `${date}%`)
    .order("game_id", { ascending: true })
    .limit(11)
    .abortSignal(signal);
  const { data, error } = await query;
  if (error) throw new Error(`known_slate_db:${error.message}`);
  if ((data?.length ?? 0) > 10) throw new Error("known_slate_overflow");
  return (data ?? [])
    .map((row) => row.game_id)
    .filter((gameId): gameId is string => typeof gameId === "string");
}

const DEFAULT_DEPS: GameLiveRouteDeps = {
  fetchKnownSlateIdsImpl: fetchKnownSlateIds,
};

function requiresStarterContract(game: KboRawGame): boolean {
  return !isKboGameCancelled(game.CANCEL_SC_ID);
}

function starterContractIncomplete(games: KboRawGame[]): boolean {
  return games.some((game) => (
    requiresStarterContract(game)
    && (!game.T_PIT_P_NM?.trim() || !game.B_PIT_P_NM?.trim())
  ));
}

function slateMatches(games: Array<{ gameId: string }>, knownSlateIds: string[]): boolean {
  const gameIds = [...new Set(games.map((game) => game.gameId))].sort();
  const knownIds = [...new Set(knownSlateIds)].sort();
  return gameIds.length === games.length
    && knownIds.length === knownSlateIds.length
    && gameIds.length === knownIds.length
    && gameIds.every((id, index) => id === knownIds[index]);
}

/**
 * `/api/games` is independently cached and Naver-primary, so it is the bounded
 * witness for the static starter fields when game-live's KBO-primary response
 * is transiently partial. Dynamic score/inning fields always remain from the
 * original game-live source. A different slate or incomplete witness is not
 * merged: the route fails closed and clients retain their previous snapshot.
 */
export function reconcileStarterWitness(
  games: KboRawGame[],
  witnessGames: StarterWitnessGame[],
): KboRawGame[] | null {
  const liveIds = [...new Set(games.map((game) => game.G_ID))].sort();
  const witnessIds = [...new Set(witnessGames.map((game) => game.gameId))].sort();
  if (
    liveIds.length !== games.length
    || witnessIds.length !== witnessGames.length
    || liveIds.length !== witnessIds.length
    || liveIds.some((id, index) => id !== witnessIds[index])
  ) {
    return null;
  }

  const witnessById = new Map(witnessGames.map((game) => [game.gameId, game]));
  const reconciled = games.map((game) => {
    if (!requiresStarterContract(game)) return game;
    const witness = witnessById.get(game.G_ID);
    const away = game.T_PIT_P_NM?.trim() || witness?.awayStarterName?.trim() || "";
    const home = game.B_PIT_P_NM?.trim() || witness?.homeStarterName?.trim() || "";
    return { ...game, T_PIT_P_NM: away, B_PIT_P_NM: home };
  });
  return starterContractIncomplete(reconciled) ? null : reconciled;
}

async function fetchStarterWitness(
  req: NextRequest,
  date: string,
  signal: AbortSignal,
): Promise<StarterWitnessGame[]> {
  const url = new URL("/api/games", req.nextUrl.origin);
  url.searchParams.set("date", date);
  const response = await fetch(url, {
    headers: { "User-Agent": "KboEveryday/game-live-starter-witness" },
    signal,
  });
  if (!response.ok) throw new Error(`starter_witness_http_${response.status}`);
  const payload = await response.json() as {
    games?: StarterWitnessGame[];
  };
  if (!Array.isArray(payload.games)) throw new Error("starter_witness_schema");
  return payload.games;
}

async function fetchSlateWitnesses(
  req: NextRequest,
  date: string,
  deadlineAtMs: number,
  deps: GameLiveRouteDeps,
): Promise<[StarterWitnessGame[], string[]]> {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= SLATE_SETTLE_RESERVE_MS) {
    throw new Error("slate_witness_settle_budget_exhausted");
  }

  const controller = new AbortController();
  // Abort raw fetch/PostgREST work at a soft deadline, leaving enough of the
  // 5s route budget for delayed abort cleanup before the hard response edge.
  // Do not wrap these raw promises in runBeforeDeadline: that race can reject
  // its wrapper while the underlying I/O remains active (post-merge P0).
  const settleReserveMs = Math.min(250, Math.max(SLATE_SETTLE_RESERVE_MS, Math.floor(remainingMs / 10)));
  const timer = setTimeout(
    () => controller.abort(new DOMException("slate witness deadline", "AbortError")),
    Math.max(1, remainingMs - settleReserveMs),
  );
  let firstFailure: unknown;
  const abortOnFailure = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      firstFailure ??= error;
      controller.abort(error);
      throw error;
    }
  };

  try {
    const settled = await Promise.allSettled([
      abortOnFailure(() => fetchStarterWitness(req, date, controller.signal)),
      abortOnFailure(() => deps.fetchKnownSlateIdsImpl(date, deadlineAtMs, controller.signal)),
    ] as const);
    if (firstFailure !== undefined) throw firstFailure;
    if (settled[0].status === "rejected") throw settled[0].reason;
    if (settled[1].status === "rejected") throw settled[1].reason;
    return [settled[0].value, settled[1].value];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * trace 헤더 + 캐시 헤더를 함께 만드는 단일 지점.
 *
 * ⚠️ 이 route 는 **엣지 캐시 대상이 아니다**(삼순 NO-GO 2026-08-06 ①).
 * relay 와 달리 여기엔 동등한 route 내부 TTL 이 없어서, s-maxage 를 새로 붙이면
 * 점수·이닝·볼카운트·현재 타석이 그 TTL 만큼 **실제로 더 낡아진다** =
 * "활성 유저 신선도 저하 0" 하드 제약 위반. 처음 이 PR 이 5초를 붙였고 그건 틀렸다.
 *
 * 엣지 캐시를 붙이려면 먼저 route 내부 TTL 을 도입해 동치를 만든 뒤 별도 PR 로 한다.
 * 그래서 정상 200 이든 fail-close 503 이든 전부 no-store 다.
 */
function traceHeaders(trace: GameLiveTrace): Record<string, string> {
  return {
    "X-Game-Live-Source": trace.source,
    "X-Game-Live-Stage": trace.stage,
    "X-Game-Live-Deadline": String(trace.deadlineAtMs),
    ...NO_STORE_HEADERS,
  };
}

const __diagSeenPitchers = new Set<string>();

function diagMissingPitcherPhoto(pitcherName: string | null, gameId: string) {
  if (!pitcherName) return;
  if (PLAYER_PHOTO_MAP[pitcherName]) return;
  if (!/^[가-힣]+$/.test(pitcherName)) return;
  if (__diagSeenPitchers.has(pitcherName)) return;
  __diagSeenPitchers.add(pitcherName);
  const codepoints = [...pitcherName].map(c => c.codePointAt(0)!.toString(16)).join(" ");
  const utf8 = Buffer.from(pitcherName, "utf-8").toString("hex");
  console.warn(
    `[diag/missing-pitcher-photo] gameId=${gameId} name=${JSON.stringify(pitcherName)} ` +
      `len=${pitcherName.length} codepoints=${codepoints} utf8=${utf8}`
  );
}

export async function gameLiveRoute(
  req: NextRequest,
  depsOverride: Partial<GameLiveRouteDeps> = {},
) {
  const deps = { ...DEFAULT_DEPS, ...depsOverride };
  const date = req.nextUrl.searchParams.get("date") || resolveGameLiveDate();
  const deadlineAtMs = Date.now() + GAME_LIVE_DEADLINE_MS;
  
  try {
    // Reserve the final route slice for the independent witness and durable
    // slate query, including their abort cleanup, before any source work starts.
    const sourceDeadlineAtMs = deadlineAtMs - SLATE_WITNESS_BUDGET_MS;
    const sourceResult = await fetchKboLiveGames(date, sourceDeadlineAtMs);
    const fetched = {
      ...sourceResult,
      trace: { ...sourceResult.trace, deadlineAtMs },
    };
    if (!fetched.ok) {
      return NextResponse.json(
        { error: "dual-source live games unavailable", games: [], date, trace: fetched.trace },
        { status: 503, headers: traceHeaders(fetched.trace) },
      );
    }

    let rawGames = fetched.games;
    let trace: GameLiveTrace = fetched.trace;
    try {
      // The independently sourced schedule is also the full-slate witness.
      // Always compare it, including scheduled games: otherwise a 4/5 KBO
      // partial or a Naver 5-game response with 0/10 starters is silently
      // accepted merely because no live/final game triggered the old guard.
      const [witness, knownSlateIds] = await fetchSlateWitnesses(
        req,
        date,
        deadlineAtMs,
        deps,
      );
      if (knownSlateIds.length > 0 && (
        !slateMatches(rawGames.map((game) => ({ gameId: game.G_ID })), knownSlateIds)
        || !slateMatches(witness, knownSlateIds)
      )) {
        trace = { ...trace, stage: "known-slate-mismatch", fetchedAtMs: Date.now() };
        return NextResponse.json(
          { error: "live slate differs from durable known slate", games: [], date, trace },
          { status: 503, headers: traceHeaders(trace) },
        );
      }
      const reconciled = reconcileStarterWitness(rawGames, witness);
      if (!reconciled) {
        trace = { ...trace, stage: "starter-witness-failed", fetchedAtMs: Date.now() };
        return NextResponse.json(
          { error: "starter witness incomplete", games: [], date, trace },
          { status: 503, headers: traceHeaders(trace) },
        );
      }
      rawGames = reconciled;
      trace = { ...trace, stage: "starter-witness", fetchedAtMs: Date.now() };
    } catch {
      trace = { ...trace, stage: "starter-witness-failed", fetchedAtMs: Date.now() };
      return NextResponse.json(
        { error: "starter witness unavailable", games: [], date, trace },
        { status: 503, headers: traceHeaders(trace) },
      );
    }

    const games = rawGames.map((g: KboRawGame) => {
      const status = isKboGameCancelled(g.CANCEL_SC_ID) ? "cancelled"
        : g.GAME_STATE_SC === "3" ? "final"
        : g.GAME_STATE_SC === "2" ? "live"
        : "scheduled";
      const resolvedPlayers = resolveCurrentPlayers({
        tPlayerName: g.T_P_NM,
        bPlayerName: g.B_P_NM,
        gameTbSc: g.GAME_TB_SC,
      });
      if (status === "live") {
        diagMissingPitcherPhoto(resolvedPlayers.currentPitcher, g.G_ID);
      }
      return {
        gameId: g.G_ID,
        awayName: g.AWAY_NM,
        homeName: g.HOME_NM,
        awayScore: status !== "scheduled" ? parseInt(g.T_SCORE_CN) || 0 : 0,
        homeScore: status !== "scheduled" ? parseInt(g.B_SCORE_CN) || 0 : 0,
        inning: g.GAME_INN_NO ?? 0,
        isTop: g.GAME_TB_SC === "T",
        balls: g.BALL_CN ?? 0,
        strikes: g.STRIKE_CN ?? 0,
        outs: g.OUT_CN ?? 0,
        runner1b: (g.B1_BAT_ORDER_NO ?? 0) > 0,
        runner2b: (g.B2_BAT_ORDER_NO ?? 0) > 0,
        runner3b: (g.B3_BAT_ORDER_NO ?? 0) > 0,
        runner1bOrder: g.B1_BAT_ORDER_NO ?? 0,
        runner2bOrder: g.B2_BAT_ORDER_NO ?? 0,
        runner3bOrder: g.B3_BAT_ORDER_NO ?? 0,
        runner1bName: null,
        runner2bName: null,
        runner3bName: null,
        ...resolvedPlayers,
        date: g.G_DT,
        stadium: g.S_NM,
        status,
        // 취소 사유는 status 와 같은 조건으로만 실는다(값-플래그 결속). 사유 미수신은 null.
        cancelReason: parseCancelReason(status, g.CANCEL_SC_NM),
        currentInning: g.GAME_INN_NO ? `${g.GAME_INN_NO}회${g.GAME_TB_SC === "T" ? "초" : "말"}` : "",
        isLive: g.GAME_STATE_SC === "2",
        time: g.G_TM || "",
        awayStarterName: g.T_PIT_P_NM?.trim() || null,
        homeStarterName: g.B_PIT_P_NM?.trim() || null,
      };
    });

    // 정상 경로만 엣지 캐시 대상이다. 위 503 fail-close 분기들은 cacheable 기본값(false)
    // 으로 no-store 를 받아 다음 폴링이 즉시 재시도한다.
    return NextResponse.json(
      { games, date, trace },
      { headers: traceHeaders(trace) },
    );
  } catch (e: unknown) {
    const trace: GameLiveTrace = {
      source: "none",
      stage: "route-fail-close",
      sourceAtMs: deadlineAtMs - GAME_LIVE_DEADLINE_MS,
      fetchedAtMs: Date.now(),
      deadlineAtMs,
    };
    return NextResponse.json(
      { error: (e as Error).message, games: [], date, trace },
      { status: 503, headers: traceHeaders(trace) },
    );
  }
}

export async function GET(req: NextRequest) {
  return gameLiveRoute(req);
}
