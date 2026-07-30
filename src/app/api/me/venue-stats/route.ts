/**
 * 직관 다이어리 통계 v1 — 본인 전용 시즌 집계 API (S1b).
 * spec: Notion "[기획] 직관 다이어리 통계 v1" rev5 §7(API 확정)·§9(S1 exact)
 *
 * GET /api/me/venue-stats?season=2026
 *  - §7 확정: overall(GPS+직접추가)/gps(story_geofence만)를 동일 스키마로 동시 반환.
 *  - 성적 모수는 정규시즌(srId="0") final만 (§5). 조회 안 되는 game은 game_unavailable
 *    → snapshot 의존 metric invalid_snapshot fail-closed (§10).
 *  - player_game_logs·standings 비교는 supportedSeason=2026에서만. 다른 시즌은
 *    attendance_only (§9 지원 시즌 상태).
 *  - B/C 완전성은 ledger + runtime canonical hash 대조(§11) — 순수 로직은
 *    src/lib/venue-stats/aggregate.ts, 시즌 집계는 venue_stats_season_team_aggregates RPC.
 *  - 시즌 경기 우주는 정규시즌 final 전체 스케줄(getSeasonGames)을 먼저 구성하고 RPC가
 *    ledger를 LEFT JOIN — ledger 없는 경기는 complete=false 강등(누락 금지, 삼순 리뷰 P0).
 */
import { NextRequest, NextResponse } from "next/server";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { fetchGames, fetchStandings, type TeamStanding } from "@/lib/crawler/kbo-api";
import {
  collectSeasonGameUniverse,
  type SeasonGameFetcher,
} from "@/lib/crawler/season-games-cache";
import type { LedgerRecord } from "@/lib/game-logs/completeness";
import { TEAM_ID_TO_CODE, type PlayerGameLogRow } from "@/lib/game-logs/ingest";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { fetchAttendanceGamesWithinDeadline } from "@/lib/venue-attendance/fetch-games";
import type { FavoritePlayerSnapshot } from "@/lib/venue-attendance/player-comparison";
import type { VenueAttendanceRow } from "@/lib/venue-attendance/summary";
import {
  buildVenueStatsScope,
  parseGameTeamCodes,
  type SeasonGameVerification,
  type TeamSeasonTotals,
} from "@/lib/venue-stats/aggregate";
import type { SeasonSupportStatus } from "@/lib/venue-stats/types";

export const maxDuration = 60;

/** §9 supportedSeason — player_game_logs ledger·standings 비교 소스가 있는 시즌. */
const SUPPORTED_SEASON = 2026;
/** 정규시즌만 (§5). srId 근거는 cron/game-logs·backfill과 동일. */
const REGULAR_SEASON_SR_ID = "0";

/** 팀코드 → teamId (parseGameTeamCodes가 쓰는 TEAM_ID_TO_CODE의 역맵) — P0-2 teams exact 대조용. */
const TEAM_CODE_TO_ID = new Map<string, number>(
  Object.entries(TEAM_ID_TO_CODE).map(([id, code]) => [code, Number(id)]),
);

function currentKstYear(): number {
  return Number(
    new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric" }).format(
      new Date(),
    ),
  );
}

function todayKst(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function normalizeFavorites(value: unknown): FavoritePlayerSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const raw = item as Record<string, unknown>;
      if (
        typeof raw.playerId !== "string" ||
        typeof raw.name !== "string" ||
        typeof raw.teamId !== "number"
      ) {
        return [];
      }
      return [{
        playerId: raw.playerId,
        name: raw.name,
        teamId: raw.teamId,
        position: typeof raw.position === "string" ? raw.position : undefined,
      }];
    })
    .slice(0, 5);
}

/** 직관 game_id들의 player_game_logs 전체 행 (완전성 hash 검증 + B/C 집계 공용). */
async function fetchAttendanceGameLogs(
  gameIds: string[],
): Promise<{ rows: PlayerGameLogRow[]; ok: boolean }> {
  if (gameIds.length === 0) return { rows: [], ok: true };
  const rows: PlayerGameLogRow[] = [];
  const pageSize = 1_000;
  // query-guard: bounded-page -- 본인 시즌 직관 ≤200경기 × 경기당 ≤40행을 1k 페이지로 순회
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("player_game_logs")
      .select(
        "kbo_id, player_type, game_id, game_date, team_id, team_code, opponent_team_id, is_home, result, ab, h, hr, rbi, bb, so, ip_outs, er, h_allowed, k, bb_allowed",
      )
      .in("game_id", gameIds)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) return { rows: [], ok: false };
    const page = (data ?? []) as unknown as PlayerGameLogRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return { rows, ok: true };
}

async function fetchLedgers(
  gameIds: string[],
): Promise<{ ledgers: Map<string, LedgerRecord>; ok: boolean }> {
  const ledgers = new Map<string, LedgerRecord>();
  if (gameIds.length === 0) return { ledgers, ok: true };
  // query-guard: bounded -- 직관 game_id(≤200) PK IN 조회
  const { data, error } = await supabase
    .from("player_game_log_ingestions")
    .select("game_id, status, expected_row_count, expected_payload_hash")
    .in("game_id", gameIds)
    .limit(gameIds.length);
  if (error) return { ledgers, ok: false };
  for (const row of data ?? []) {
    ledgers.set(row.game_id as string, {
      status: row.status as LedgerRecord["status"],
      expected_row_count: row.expected_row_count as number | null,
      expected_payload_hash: row.expected_payload_hash as string | null,
    });
  }
  return { ledgers, ok: true };
}

async function fetchFavoriteSeasonLogs(
  favorites: FavoritePlayerSnapshot[],
  season: number,
): Promise<{ rows: PlayerGameLogRow[]; ok: boolean }> {
  if (favorites.length === 0) return { rows: [], ok: true };
  const rows: PlayerGameLogRow[] = [];
  const pageSize = 1_000;
  // query-guard: bounded-page -- 최애 ≤5명 × 시즌 ≤144경기 로그를 1k 페이지로 순회
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("player_game_logs")
      .select(
        "kbo_id, player_type, game_id, game_date, team_id, team_code, opponent_team_id, is_home, result, ab, h, hr, rbi, bb, so, ip_outs, er, h_allowed, k, bb_allowed",
      )
      .in("kbo_id", favorites.map((favorite) => favorite.playerId))
      .gte("game_date", `${season}-01-01`)
      .lt("game_date", `${season + 1}-01-01`)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) return { rows: [], ok: false };
    const page = (data ?? []) as unknown as PlayerGameLogRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return { rows, ok: true };
}

interface SeasonAggregates {
  seasonGames: SeasonGameVerification[] | null;
  teamSeasonTotals: Map<number, TeamSeasonTotals> | null;
}

/** 시즌 집계 의존성 주입 seam — 수집 fetcher·RPC 경계만 교체 가능(삼순 P0 fail-closed 회귀용). */
export interface SeasonAggregatesDeps {
  /** 일자별 경기 fetcher (기본=실네트워크). 수집 로직은 항상 실제 collectSeasonGameUniverse 경유. */
  fetcher?: SeasonGameFetcher;
  /** RPC 호출(기본=supabase). */
  rpc?: (args: {
    p_season: number;
    p_games: Array<{ gameId: string; gameDate: string }>;
  }) => Promise<{ data: unknown; error: unknown }>;
}

/** KboGame.date(YYYYMMDD) → YYYY-MM-DD. 형식 이탈은 null(우주 무결성 훼손 → fail-closed). */
function toIsoGameDate(raw: string): string | null {
  if (!/^\d{8}$/.test(raw)) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

/**
 * S1b 시즌 집계 — §11 경기 우주: 정규시즌 final 전체 스케줄(권위 소스)을 먼저 구성해
 * RPC에 넘기고, RPC가 ledger를 LEFT JOIN해 ledger 없는 경기를 complete=false로 강등한다
 * (우주 누락 금지 — 삼순 리뷰 P0). 일자별 수집이 한 날짜라도 실패한 non-empty partial 우주,
 * RPC 실패·빈 우주·우주↔응답 gameId+gameDate exact 집합 불일치는 모두 null —
 * B/C attendance_only·E1 unsupported fail-closed (조용한 partial·ready·null false-green 금지).
 */
async function computeSeasonAggregates(
  season: number,
  deps: SeasonAggregatesDeps = {},
): Promise<SeasonAggregates> {
  const failClosed: SeasonAggregates = { seasonGames: null, teamSeasonTotals: null };
  let universe: Array<{ gameId: string; gameDate: string }>;
  try {
    const collection = await collectSeasonGameUniverse(season, REGULAR_SEASON_SR_ID, {
      fetcher: deps.fetcher,
    });
    // 삼순 P0 gate 1 — 일자 1건이라도 수집 실패한 non-empty partial 우주는
    // authoritative로 쓰지 않는다 — 그대로 B/C attendance_only·E1 unsupported로 fail-closed.
    if (!collection.complete) return failClosed;
    const seen = new Set<string>();
    universe = [];
    for (const g of collection.games) {
      if (g.status !== "final" || seen.has(g.gameId)) continue;
      const gameDate = toIsoGameDate(String(g.date ?? ""));
      if (gameDate === null) return failClosed;
      seen.add(g.gameId);
      universe.push({ gameId: g.gameId, gameDate });
    }
  } catch {
    return failClosed;
  }
  if (universe.length === 0) return failClosed;

  const rpc =
    deps.rpc ??
    (async (args) => supabase.rpc("venue_stats_season_team_aggregates", args));
  const { data, error } = await rpc({ p_season: season, p_games: universe });
  if (error || !data || typeof data !== "object") {
    return failClosed;
  }
  const payload = data as {
    games?: Array<{ gameId?: unknown; gameDate?: unknown; complete?: unknown }>;
    teams?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(payload.games) || !Array.isArray(payload.teams)) {
    return failClosed;
  }
  const seasonGames: SeasonGameVerification[] = payload.games.flatMap((g) => {
    if (typeof g.gameId !== "string" || typeof g.gameDate !== "string") return [];
    return [{
      gameId: g.gameId,
      gameDate: g.gameDate,
      complete: g.complete === true,
      teamCodes: parseGameTeamCodes(g.gameId),
    }];
  });
  // 삼순 P0 gate 2 — RPC 반환 games의 gameId+gameDate exact 집합이 입력 우주와
  // 정확히 일치해야 한다. 길이만 비교하면 동수 ID 치환·중복·누락 드리프트를 놓친다.
  const universeKey = (g: { gameId: string; gameDate: string }) =>
    `${g.gameId}\u0000${g.gameDate}`;
  const rpcKeys = new Set(seasonGames.map(universeKey));
  if (rpcKeys.size !== universe.length) return failClosed;
  for (const u of universe) {
    if (!rpcKeys.has(universeKey(u))) return failClosed;
  }
  // 삼순 P0-2 gate — teams exact + malformed reject.
  //  1) complete 우주 경기의 참가팀(gameId 코드→teamId) 집합을 기대 집합으로 삼고,
  //  2) RPC teams 집합과 exact 대조(누락/우주 밖/중복 → fail-closed),
  //  3) 값은 finite 비음 정수만 허용 — Number(v)||0 조용한 0 오염 제거(NaN/누락/음수 → fail-closed).
  // complete 경기에 참가팀이 있으면 teams는 반드시 그 팀들을 담아야 한다 —
  // teams=[]/partial이 B1을 ready·seasonAvg=null false-green으로 만드는 것을 원천 차단.
  const completeTeamGameCounts = new Map<number, number>();
  for (const g of seasonGames) {
    if (!g.complete) continue;
    for (const code of g.teamCodes) {
      const teamId = TEAM_CODE_TO_ID.get(code);
      if (teamId === undefined) return failClosed; // complete 경기 팀코드 해석 불가 → fail-closed
      completeTeamGameCounts.set(teamId, (completeTeamGameCounts.get(teamId) ?? 0) + 1);
    }
  }
  const expectedTeamIds = new Set(completeTeamGameCounts.keys());
  const nonNegInt = (v: unknown): number | null =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
  const teamSeasonTotals = new Map<number, TeamSeasonTotals>();
  for (const t of payload.teams) {
    const teamId = nonNegInt(t.teamId);
    // 유효하지 않은/우주 밖/중복 teamId → fail-closed.
    if (teamId === null || !expectedTeamIds.has(teamId) || teamSeasonTotals.has(teamId)) {
      return failClosed;
    }
    const completeGames = nonNegInt(t.completeGames);
    const ab = nonNegInt(t.ab);
    const h = nonNegInt(t.h);
    const hr = nonNegInt(t.hr);
    const outs = nonNegInt(t.outs);
    const er = nonNegInt(t.er);
    const hAllowed = nonNegInt(t.hAllowed);
    if (
      completeGames === null || ab === null || h === null || hr === null ||
      outs === null || er === null || hAllowed === null
    ) {
      return failClosed; // malformed(NaN/누락/음수/비정수) → 조용한 0 대체 금지, fail-closed
    }
    // completeGames는 1 이상, 우주 내 해당 팀 complete 경기 수를 초과할 수 없다.
    if (completeGames < 1 || completeGames > (completeTeamGameCounts.get(teamId) ?? 0)) {
      return failClosed;
    }
    teamSeasonTotals.set(teamId, { teamId, completeGames, ab, h, hr, outs, er, hAllowed });
  }
  // exact — 기대 팀이 하나라도 빠지면(teams=[] 포함) fail-closed.
  for (const teamId of expectedTeamIds) {
    if (!teamSeasonTotals.has(teamId)) return failClosed;
  }
  return { seasonGames, teamSeasonTotals };
}

// ── 삼순 P0-3 — complete-only 시즌 캐시 + single-flight ─────────────────────────
// /api/me/venue-stats 1회 호출이 시즌 우주 수집으로 153 fetch를 생성하고 반복 호출마다
// 또 +153하는 폭주를 막는다. 완전 우주(non-failClosed = seasonGames≠null && teamSeasonTotals≠null)
// 결과만 시즌 단위 TTL 캐시하고(불완전/partial은 절대 캐시 금지 — r3 계약),
// 동시 요청은 single-flight로 같은 시즌 in-flight 1개에 합류시킴다.
interface SeasonAggregatesCacheEntry {
  value: SeasonAggregates;
  expiresAt: number;
}
const seasonAggregatesCache = new Map<number, SeasonAggregatesCacheEntry>();
const seasonAggregatesInflight = new Map<number, Promise<SeasonAggregates>>();

/** 시즌 캐시 TTL(ms) — 경기시간(KST 11~24시) 10분, 그 외 60분 (month cache와 동일 정책). */
function seasonAggregatesTtlMs(): number {
  const kstHour = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }),
  ).getHours();
  return kstHour >= 11 && kstHour < 24 ? 10 * 60 * 1000 : 60 * 60 * 1000;
}

function isCompleteAggregates(a: SeasonAggregates): boolean {
  return a.seasonGames !== null && a.teamSeasonTotals !== null;
}

/**
 * 시즌 집계 — complete-only 캐시 + single-flight 로 감싸 computeSeasonAggregates.
 * 캐시 명중: TTL 내 완전 결과 재사용(수집 0회). in-flight 합류: 동시 N호출=수집 1회.
 * 불완전(failClosed) 결과는 캐시하지 않아 다음 호출이 재수집(정합성 유지).
 */
export async function fetchSeasonAggregates(
  season: number,
  deps: SeasonAggregatesDeps = {},
): Promise<SeasonAggregates> {
  const cached = seasonAggregatesCache.get(season);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const inflight = seasonAggregatesInflight.get(season);
  if (inflight) return inflight; // single-flight 합류 — 같은 시즌 수집 1회만

  const run = (async () => {
    const result = await computeSeasonAggregates(season, deps);
    // complete-only — 완전 우주 + exact 통과(=non-failClosed)만 캐시. partial 캐시 금지.
    if (isCompleteAggregates(result)) {
      seasonAggregatesCache.set(season, {
        value: result,
        expiresAt: Date.now() + seasonAggregatesTtlMs(),
      });
    }
    return result;
  })().finally(() => {
    seasonAggregatesInflight.delete(season);
  });
  seasonAggregatesInflight.set(season, run);
  return run;
}

/** 테스트 전용 — 시즌 캐시/in-flight 초기화(케이스 간 교차 오염 방지). production 미사용. */
export function __resetSeasonAggregatesCaches(): void {
  seasonAggregatesCache.clear();
  seasonAggregatesInflight.clear();
}

/** 테스트 전용 — 특정 시즌 캐시를 만료시켜 TTL-후 refresh 회귀 검증. */
export function __expireSeasonAggregatesCache(season: number): void {
  const entry = seasonAggregatesCache.get(season);
  if (entry) entry.expiresAt = 0;
}

/** 본인 전용 — userId 파라미터를 받지 않아 공개 프로필 조회로 확장되지 않는다 (§9 401·타인 차단). */
export async function GET(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  const nowYear = currentKstYear();
  const requestedSeason = Number(req.nextUrl.searchParams.get("season") ?? nowYear);
  if (!Number.isInteger(requestedSeason) || requestedSeason < 2020 || requestedSeason > nowYear) {
    return NextResponse.json({ error: "season 형식 오류" }, { status: 400 });
  }
  const seasonSupported = requestedSeason === SUPPORTED_SEASON;

  // query-guard: bounded -- 본인 시즌 직관 기록 상한 200경기 (기존 venue-attendance route와 동일)
  const [attendanceResult, profileResult] = await Promise.all([
    supabase
      .from("venue_attendance")
      .select(
        "id, game_id, game_date, favorite_team_id_snapshot, stadium_name, recorded_at, source",
      )
      .eq("user_id", verified.user.id)
      .in("source", ["story_geofence", "diary_manual"])
      .gte("game_date", `${requestedSeason}-01-01`)
      .lt("game_date", `${requestedSeason + 1}-01-01`)
      .order("game_date", { ascending: false })
      .limit(200),
    supabase
      .from("profiles")
      .select("favorite_players, team_id")
      .eq("id", verified.user.id)
      .maybeSingle(),
  ]);

  if (attendanceResult.error) {
    return NextResponse.json({ error: "직관 기록 조회 실패" }, { status: 500 });
  }
  if (profileResult.error) {
    return NextResponse.json({ error: "프로필 조회 실패" }, { status: 500 });
  }

  const rows = (attendanceResult.data ?? []) as VenueAttendanceRow[];
  const gameIds = [...new Set(rows.map((row) => row.game_id))];
  const favorites = normalizeFavorites(profileResult.data?.favorite_players);
  const currentTeamId =
    typeof profileResult.data?.team_id === "number" ? profileResult.data.team_id : null;

  const [gamesById, logsResult, ledgersResult, seasonAggregates, favoriteSeasonResult, standings] =
    await Promise.all([
      fetchAttendanceGamesWithinDeadline(rows, {
        fetcher: (date) => fetchGames(date, REGULAR_SEASON_SR_ID),
      }),
      fetchAttendanceGameLogs(gameIds),
      fetchLedgers(gameIds),
      seasonSupported
        ? fetchSeasonAggregates(requestedSeason)
        : Promise.resolve<SeasonAggregates>({ seasonGames: null, teamSeasonTotals: null }),
      seasonSupported
        ? fetchFavoriteSeasonLogs(favorites, requestedSeason)
        : Promise.resolve({ rows: [], ok: true }),
      seasonSupported
        ? fetchStandings().catch(() => null as TeamStanding[] | null)
        : Promise.resolve<TeamStanding[] | null>(null),
    ]);

  // 로그/ledger 조회 실패는 fail-closed — ledger 없음 취급(incomplete)으로 B/C가 partial로 강등된다.
  const attendanceLogs = logsResult.ok ? logsResult.rows : [];
  const ledgers = ledgersResult.ok ? ledgersResult.ledgers : new Map<string, LedgerRecord>();

  const shared = {
    season: requestedSeason,
    supportedSeason: SUPPORTED_SEASON,
    rows,
    games: gamesById,
    standings,
    currentTeamId,
    favorites,
    attendanceLogs,
    ledgers,
    seasonGames: seasonAggregates.seasonGames,
    teamSeasonTotals: seasonAggregates.teamSeasonTotals,
    favoriteSeasonLogs: favoriteSeasonResult.ok ? favoriteSeasonResult.rows : [],
    todayKst: todayKst(),
  } as const;

  const seasonSupport: { status: SeasonSupportStatus; supportedSeason: number } = {
    status: seasonSupported ? "supported" : "attendance_only",
    supportedSeason: SUPPORTED_SEASON,
  };

  return NextResponse.json(
    {
      season: requestedSeason,
      seasonSupport,
      // §7 확정 — overall/gps 동일 스키마 동시 반환.
      overall: buildVenueStatsScope({ ...shared, scope: "overall" }),
      gps: buildVenueStatsScope({ ...shared, scope: "gps" }),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
