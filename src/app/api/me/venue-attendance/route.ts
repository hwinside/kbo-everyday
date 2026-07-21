import { NextRequest, NextResponse } from "next/server";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { fetchGames } from "@/lib/crawler/kbo-api";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { fetchAttendanceGamesWithinDeadline } from "@/lib/venue-attendance/fetch-games";
import {
  buildVenueDiaryItem,
  summarizeVenueAttendance,
  type VenueAttendanceRow,
} from "@/lib/venue-attendance/summary";
import {
  buildFavoritePlayerPerformances,
  type FavoritePlayerSnapshot,
  type PlayerGameLog,
} from "@/lib/venue-attendance/player-comparison";

export const maxDuration = 60;

function currentKstYear(): number {
  return Number(
    new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric" }).format(
      new Date(),
    ),
  );
}

function normalizeFavorites(value: unknown): FavoritePlayerSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    if (
      typeof raw.playerId !== "string" ||
      typeof raw.name !== "string" ||
      typeof raw.teamId !== "number"
    ) return [];
    return [{
      playerId: raw.playerId,
      name: raw.name,
      teamId: raw.teamId,
      position: typeof raw.position === "string" ? raw.position : undefined,
    }];
  }).slice(0, 5);
}

async function fetchFavoriteLogs(
  favorites: FavoritePlayerSnapshot[],
  season: number,
): Promise<{ rows: PlayerGameLog[]; ok: boolean }> {
  if (favorites.length === 0) return { rows: [], ok: true };

  const rows: PlayerGameLog[] = [];
  const pageSize = 1_000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("player_game_logs")
      .select("kbo_id, player_type, game_id, game_date, team_id, ab, h, hr, rbi, bb, so, ip_outs, er, h_allowed, k, bb_allowed")
      .in("kbo_id", favorites.map((favorite) => favorite.playerId))
      .gte("game_date", `${season}-01-01`)
      .lt("game_date", `${season + 1}-01-01`)
      .order("game_date", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) return { rows: [], ok: false };
    const page = (data ?? []) as PlayerGameLog[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return { rows, ok: true };
}

/** 본인 전용 직관 다이어리. userId 파라미터를 받지 않아 공개 프로필 조회로 확장되지 않는다. */
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

  const [attendanceResult, profileResult] = await Promise.all([
    supabase
      .from("venue_attendance")
      .select(
        "id, game_id, game_date, favorite_team_id_snapshot, stadium_name, recorded_at",
      )
      .eq("user_id", verified.user.id)
      .eq("source", "story_geofence")
      .gte("game_date", `${requestedSeason}-01-01`)
      .lt("game_date", `${requestedSeason + 1}-01-01`)
      .order("game_date", { ascending: false })
      .limit(200),
    supabase
      .from("profiles")
      .select("favorite_players")
      .eq("id", verified.user.id)
      .maybeSingle(),
  ]);

  if (attendanceResult.error) {
    return NextResponse.json({ error: "직관 기록 조회 실패" }, { status: 500 });
  }
  if (profileResult.error) {
    return NextResponse.json({ error: "최애선수 조회 실패" }, { status: 500 });
  }

  const rows = (attendanceResult.data ?? []) as VenueAttendanceRow[];
  const favorites = normalizeFavorites(profileResult.data?.favorite_players);
  const [gamesById, favoriteLogResult] = await Promise.all([
    fetchAttendanceGamesWithinDeadline(rows, { fetcher: fetchGames }),
    fetchFavoriteLogs(favorites, requestedSeason),
  ]);
  const games = rows.map((row) => {
    const game = gamesById.get(row.game_id) ?? null;
    return {
      ...buildVenueDiaryItem(row, game),
      favoritePlayers: buildFavoritePlayerPerformances({
        favorites,
        logs: favoriteLogResult.rows,
        game,
        logsReady: favoriteLogResult.ok,
      }),
    };
  });

  return NextResponse.json(
    {
      season: requestedSeason,
      summary: summarizeVenueAttendance(games),
      games,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
