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
import { fetchGameErrorsWithinDeadline } from "@/lib/venue-stats/game-errors";
import bundledBatters from "@/lib/constants/stats-2026-batters.json";
import bundledPitchers from "@/lib/constants/stats-2026-pitchers.json";
import statsMeta from "@/lib/constants/stats-2026-meta.json";
import type { FavoritePlayerSnapshot } from "@/lib/venue-attendance/player-comparison";
import type { VenueAttendanceRow } from "@/lib/venue-attendance/summary";
import {
  buildVenueStatsScope,
  parseGameTeamCodes,
  type SeasonGameVerification,
  type TeamSeasonTotals,
} from "@/lib/venue-stats/aggregate";
import type { SeasonSupportStatus } from "@/lib/venue-stats/types";
import { buildCurrentSeasonBaselines } from "@/lib/venue-stats/current-season-baseline";
import { loadCachedTeamRecords } from "@/app/api/team-records/route";

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

async function fetchLiveSeasonSnapshots(): Promise<{
  batters: Array<Record<string, unknown>>;
  pitchers: Array<Record<string, unknown>>;
}> {
  const [batterResult, pitcherResult] = await Promise.all([
    // query-guard: bounded -- KBO 현재시즌 10구단 선수 스냅샷은 1,000명 상한, 1,001행은 overflow로 폴백한다.
    supabase
      .from("player_stats_batter")
      .select("kbo_id, team, games, ab, hits, hr, rbi, updated_at")
      .limit(1_001),
    // query-guard: bounded -- KBO 현재시즌 10구단 선수 스냅샷은 1,000명 상한, 1,001행은 overflow로 폴백한다.
    supabase
      .from("player_stats_pitcher")
      .select("kbo_id, team, games, ip, h, er, so, updated_at")
      .limit(1_001),
  ]);
  const batterRows = batterResult.data ?? [];
  const pitcherRows = pitcherResult.data ?? [];
  return {
    // DB 열화/실패는 stale 값을 0으로 만들지 않고 버전 고정 번들 스냅샷으로 폴백한다.
    batters: batterResult.error || batterRows.length > 1_000 ? [] : batterRows as Array<Record<string, unknown>>,
    pitchers: pitcherResult.error || pitcherRows.length > 1_000 ? [] : pitcherRows as Array<Record<string, unknown>>,
  };
}

function oldestStatsGeneratedAt(): string {
  const batter = Date.parse(statsMeta.battersGeneratedAt);
  const pitcher = Date.parse(statsMeta.pitchersGeneratedAt);
  return new Date(Math.min(batter, pitcher)).toISOString();
}

interface SeasonAggregates {
  seasonGames: SeasonGameVerification[] | null;
  teamSeasonTotals: Map<number, TeamSeasonTotals> | null;
  /**
   * 공식 스코어 우주가 완전한가. false = final 중 일부 스코어/팀ID 결손.
   *
   * 삼순 P0 (2026-08-02): 이 결과는 seasonGames 가 non-null 이라도 **캐시하면 안 된다.**
   * 캐시하면 원천 소스가 복구돼도 TTL(10~60분) 동안 공식 스코어 null 이 고착된다
   * (재호출 actual 이 `추가 fetch 0 · 공식필드 0` 으로 관측됨).
   */
  officialScoresComplete: boolean;
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
 * 경기 시작시각 → 낮경기 여부. 유효한 `HH:mm`(0~23시)만 판정하고 그 밖은 undefined.
 *
 * 삼순 P1 (2026-08-02): `Number("") === 0` 이라 예전 구현은 time 결손 경기를
 * `isDayGame:true`(00시=낮) 로 오분류했다. 결손은 "모름"이지 낮경기가 아니다.
 */
export function parseDayGame(time: unknown): boolean | undefined {
  if (typeof time !== "string") return undefined;
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return undefined;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return undefined;
  return hour < 18;
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
  const failClosed: SeasonAggregates = { seasonGames: null, teamSeasonTotals: null, officialScoresComplete: false };
  let universe: Array<{ gameId: string; gameDate: string }>;
  const officialGames = new Map<string, {
    awayTeamId: number;
    homeTeamId: number;
    awayScore: number;
    homeScore: number;
  }>();
  // 삼순 P0 (2026-08-02) — 공식 시즌 득점(B3) baseline은 all-or-nothing이다.
  // final 우주 중 단 1경기라도 팀ID/스코어가 유효하지 않으면 그 경기만 조용히 빠져
  // 남은 경기로 "시즌 평균 득점"이 계산되는 부분 우주 false-green이 된다
  // (하류 aggregate는 팀ID 있는 경기만 먼저 filter하므로 결손을 볼 수 없다).
  // → 하나라도 결손이면 공식 필드를 전부 버리고 B3 시즌 baseline을 null로 fail-close.
  let officialScoreUniverseComplete = true;
  const dayGameFlags = new Map<string, boolean>();
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
      // 낮/야간 — 팀 시즌 일정의 낮 경기 "기회"를 세기 위해 보존(삼순: 기회 대비 참석 비율).
      // ⚠️ `Number("")===0` 이라 time 결손을 그대로 파싱하면 00시=낮경기로 오분류된다(삼순 P1).
      //    유효한 `HH:mm` 형식 + 0~23 시만 수용하고, 결손/형식 이탈은 undefined 로 남긴다.
      const dayGame = parseDayGame(g.time);
      if (dayGame !== undefined) dayGameFlags.set(g.gameId, dayGame);
      if (
        Number.isInteger(g.awayTeamId) && Number.isInteger(g.homeTeamId) &&
        Number.isInteger(g.awayScore) && Number.isInteger(g.homeScore) &&
        (g.awayScore ?? -1) >= 0 && (g.homeScore ?? -1) >= 0
      ) {
        officialGames.set(g.gameId, {
          awayTeamId: g.awayTeamId,
          homeTeamId: g.homeTeamId,
          awayScore: g.awayScore!,
          homeScore: g.homeScore!,
        });
      } else {
        officialScoreUniverseComplete = false;
      }
    }
  } catch {
    return failClosed;
  }
  if (!officialScoreUniverseComplete) officialGames.clear();
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
    const official = officialGames.get(g.gameId);
    return [{
      gameId: g.gameId,
      gameDate: g.gameDate,
      complete: g.complete === true,
      teamCodes: parseGameTeamCodes(g.gameId),
      ...(dayGameFlags.has(g.gameId) ? { isDayGame: dayGameFlags.get(g.gameId) } : {}),
      ...(official ?? {}),
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
    // 삼순 4차 P0-2 — completeGames는 우주에서 계산한 해당 팀 complete 경기 수와
    // exact equality여야 한다. 상한만 검사하면 undercount(실제 2 → RPC 1)가 통과해
    // B4 등 per-game 분모(시즌 합계 ÷ completeGames)를 오염시킨다 → 불일치 즉시 fail-closed.
    if (completeGames !== (completeTeamGameCounts.get(teamId) ?? 0)) {
      return failClosed;
    }
    teamSeasonTotals.set(teamId, { teamId, completeGames, ab, h, hr, outs, er, hAllowed });
  }
  // exact — 기대 팀이 하나라도 빠지면(teams=[] 포함) fail-closed.
  for (const teamId of expectedTeamIds) {
    if (!teamSeasonTotals.has(teamId)) return failClosed;
  }
  return { seasonGames, teamSeasonTotals, officialScoresComplete: officialScoreUniverseComplete };
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
  // 삼순 P0 — 공식 스코어 결손 결과도 "불완전"으로 보아 캐시하지 않는다.
  // 그래야 소스 정상화 직후 재호출이 실제로 재수집해 공식 스코어를 복구한다.
  return a.seasonGames !== null && a.teamSeasonTotals !== null && a.officialScoresComplete;
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
      .is("deleted_at", null)
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

  const [
    gamesById,
    logsResult,
    ledgersResult,
    seasonAggregates,
    standings,
    liveSeasonSnapshots,
    teamRecords,
  ] =
    await Promise.all([
      fetchAttendanceGamesWithinDeadline(rows, {
        fetcher: (date) => fetchGames(date, REGULAR_SEASON_SR_ID),
      }),
      fetchAttendanceGameLogs(gameIds),
      fetchLedgers(gameIds),
      seasonSupported
        ? fetchSeasonAggregates(requestedSeason)
        : Promise.resolve<SeasonAggregates>({ seasonGames: null, teamSeasonTotals: null, officialScoresComplete: false }),
      seasonSupported
        ? fetchStandings().catch(() => null as TeamStanding[] | null)
        : Promise.resolve<TeamStanding[] | null>(null),
      seasonSupported
        ? fetchLiveSeasonSnapshots()
        : Promise.resolve({ batters: [], pitchers: [] }),
      seasonSupported
        ? loadCachedTeamRecords(requestedSeason).catch(() => null)
        : Promise.resolve(null),
    ]);

  // 실책(D7) — linescore 기반이라 원장과 무관. 실패 경기는 Map 에 안 들어간다(=미확인).
  // ⚠️ canonical 경기 identity·팀·최종 스코어를 함께 넘겨 stale/다른 경기 응답을
  //    exact 대조한다(삼순 P0).
  //    경기 목록 조회 뒤에 실행해야 canonical 을 알 수 있으므로 위 Promise.all 밖이다.
  const gameErrors = await fetchGameErrorsWithinDeadline(
    gameIds.map((gameId) => {
      const game = gamesById.get(gameId);
      const canonical =
        game?.status === "final" &&
        typeof game.awayScore === "number" &&
        typeof game.homeScore === "number"
          ? {
              gameId: game.gameId,
              awayTeamId: game.awayTeamId,
              homeTeamId: game.homeTeamId,
              awayScore: game.awayScore,
              homeScore: game.homeScore,
            }
          : null;
      return { gameId, canonical };
    }),
  ).catch(() => new Map<string, { away: number; home: number }>());

  // 로그/ledger 조회 실패는 fail-closed — ledger 없음 취급(incomplete)으로 B/C가 partial로 강등된다.
  const attendanceLogs = logsResult.ok ? logsResult.rows : [];
  const ledgers = ledgersResult.ok ? ledgersResult.ledgers : new Map<string, LedgerRecord>();
  const currentBaselines = seasonSupported
    ? buildCurrentSeasonBaselines({
        season: requestedSeason,
        currentSeason: nowYear,
        generatedAt: oldestStatsGeneratedAt(),
        teamRecords,
        favoriteIds: favorites.map((favorite) => favorite.playerId),
        bundledBatters,
        bundledPitchers,
        liveBatters: liveSeasonSnapshots.batters,
        livePitchers: liveSeasonSnapshots.pitchers,
      })
    : null;

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
    gameErrors,
    seasonGames: seasonAggregates.seasonGames,
    teamSeasonTotals: currentBaselines?.teamSeasonTotals ?? null,
    favoriteSeasonBaselines: currentBaselines?.favoriteSeasonBaselines ?? null,
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
