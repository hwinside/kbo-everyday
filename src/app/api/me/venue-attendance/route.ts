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
import { resolveGameVenue } from "@/lib/venue-stories/venue-resolve";
import {
  decideManualAttendanceTeam,
  decideManualDiaryGame,
} from "@/lib/venue-diary/manual-upload";

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

  // query-guard: bounded -- 본인 시즌 직관 기록 UI 상한 200경기
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

  // 인증 직관수·배지·공개 트레이 계약: summary 는 GPS 인증(story_geofence) 건만 집계(기존 유지).
  // 하린아빠 정책 변경(2026-07-30): 다이어리 카드의 승률·승패 표시는 직접 추가(diary_manual)를
  // 포함한 전체가 기본값 → overallSummary 로 별도 노출하고 클라 토글로 GPS-only 와 전환한다.
  const certifiedGames = games.filter((game) => game.source === "story_geofence");
  return NextResponse.json(
    {
      season: requestedSeason,
      summary: summarizeVenueAttendance(certifiedGames),
      // 승률 표시 기본값용 전체(GPS + 직접 추가) 집계. 인증 배지·인증 직관수에는 쓰지 않는다.
      overallSummary: summarizeVenueAttendance(games),
      // 다이어리 기록 경기수는 직접 추가 포함 전체(승률과 무관한 단순 집계).
      diaryGameCount: games.length,
      games,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

/** 종료 경기 직접 등록/삭제 후 재등록. 미디어 없이 직관 원장만 만든다. */
export async function POST(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청" }, { status: 400 });
  }
  const gameId = typeof body.gameId === "string" ? body.gameId.trim() : "";
  if (!/^\d{8}[A-Za-z0-9]+$/.test(gameId)) {
    return NextResponse.json({ error: "gameId 형식 오류" }, { status: 400 });
  }

  const venue = await resolveGameVenue(gameId);
  const gameDecision = decideManualDiaryGame(venue);
  if (!gameDecision.ok) {
    return NextResponse.json(
      { error: gameDecision.error },
      { status: gameDecision.status },
    );
  }
  const teamDecision = decideManualAttendanceTeam(body.favoriteTeamId, venue);
  if (!teamDecision.ok) {
    return NextResponse.json(
      { error: teamDecision.error },
      { status: teamDecision.status },
    );
  }

  // query-guard: bounded -- 유저·경기 unique 원장 한 행의 id/status JSON만 반환
  const { data, error } = await supabase.rpc("upsert_venue_attendance_manual", {
    p_user_id: verified.user.id,
    p_game_id: gameId,
    p_game_date: venue.gameDate,
    p_favorite_team_id: teamDecision.favoriteTeamId,
    p_stadium_name: venue.stadiumName,
  });
  if (error) {
    return NextResponse.json({ error: "직관 기록 저장 실패" }, { status: 500 });
  }
  const result = (data ?? {}) as { ok?: boolean; id?: number; error?: string };
  if (result.ok === false && result.error === "source_conflict") {
    return NextResponse.json(
      { error: "GPS 인증 기록은 직접 등록으로 변경할 수 없어요" },
      { status: 409 },
    );
  }
  if (result.ok !== true || typeof result.id !== "number") {
    return NextResponse.json({ error: "직관 기록 저장 실패" }, { status: 500 });
  }
  return NextResponse.json(
    { success: true, id: result.id, source: "diary_manual" },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
