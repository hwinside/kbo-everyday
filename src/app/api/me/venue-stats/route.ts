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
 */
import { NextRequest, NextResponse } from "next/server";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { fetchGames, fetchStandings, type TeamStanding } from "@/lib/crawler/kbo-api";
import type { LedgerRecord } from "@/lib/game-logs/completeness";
import type { PlayerGameLogRow } from "@/lib/game-logs/ingest";
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

/** S1b 신설 RPC — ledger 시즌 검증 + 팀별 complete 집계. 실패는 null(B/C attendance_only fail-closed). */
async function fetchSeasonAggregates(season: number): Promise<SeasonAggregates> {
  const { data, error } = await supabase.rpc("venue_stats_season_team_aggregates", {
    p_season: season,
  });
  if (error || !data || typeof data !== "object") {
    return { seasonGames: null, teamSeasonTotals: null };
  }
  const payload = data as {
    games?: Array<{ gameId?: unknown; gameDate?: unknown; complete?: unknown }>;
    teams?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(payload.games) || !Array.isArray(payload.teams)) {
    return { seasonGames: null, teamSeasonTotals: null };
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
  const teamSeasonTotals = new Map<number, TeamSeasonTotals>();
  for (const t of payload.teams) {
    const teamId = Number(t.teamId);
    if (!Number.isInteger(teamId)) continue;
    teamSeasonTotals.set(teamId, {
      teamId,
      completeGames: Number(t.completeGames) || 0,
      ab: Number(t.ab) || 0,
      h: Number(t.h) || 0,
      hr: Number(t.hr) || 0,
      outs: Number(t.outs) || 0,
      er: Number(t.er) || 0,
      hAllowed: Number(t.hAllowed) || 0,
    });
  }
  return { seasonGames, teamSeasonTotals };
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
