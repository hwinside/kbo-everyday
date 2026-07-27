import type { KboGame } from "@/lib/crawler/kbo-api";

export type AttendanceResult = "W" | "L" | "D";
export type AttendanceDisplayStatus = KboGame["status"] | "unavailable";

export interface VenueAttendanceRow {
  id: number;
  game_id: string;
  game_date: string;
  favorite_team_id_snapshot: number | null;
  stadium_name: string | null;
  recorded_at: string;
  source: "story_geofence" | "diary_manual";
}

export interface VenueDiaryItem {
  id: number;
  gameId: string;
  date: string;
  stadium: string | null;
  favoriteTeamId: number | null;
  recordedAt: string;
  source: "story_geofence" | "diary_manual";
  venueVerified: boolean;
  status: AttendanceDisplayStatus;
  result: AttendanceResult | null;
  awayTeam: { id: number; name: string; score: number | null } | null;
  homeTeam: { id: number; name: string; score: number | null } | null;
}

export interface VenueAttendanceSummary {
  attendanceCount: number;
  wins: number;
  losses: number;
  draws: number;
  finalCount: number;
  winRate: number | null;
}

/** 최애팀은 현재 profile이 아니라 직관 인증 시점 스냅샷만 사용한다. */
export function buildVenueDiaryItem(
  row: VenueAttendanceRow,
  game: KboGame | null,
): VenueDiaryItem {
  let result: AttendanceResult | null = null;

  if (
    game?.status === "final" &&
    row.favorite_team_id_snapshot != null &&
    game.awayScore != null &&
    game.homeScore != null
  ) {
    const isAway = game.awayTeamId === row.favorite_team_id_snapshot;
    const isHome = game.homeTeamId === row.favorite_team_id_snapshot;

    if (isAway || isHome) {
      const myScore = isAway ? game.awayScore : game.homeScore;
      const opponentScore = isAway ? game.homeScore : game.awayScore;
      result = myScore > opponentScore ? "W" : myScore < opponentScore ? "L" : "D";
    }
  }

  return {
    id: row.id,
    gameId: row.game_id,
    date: row.game_date,
    stadium: game?.stadium ?? row.stadium_name,
    favoriteTeamId: row.favorite_team_id_snapshot,
    recordedAt: row.recorded_at,
    source: row.source,
    venueVerified: row.source === "story_geofence",
    status: game?.status ?? "unavailable",
    result,
    awayTeam: game
      ? { id: game.awayTeamId, name: game.awayName, score: game.awayScore }
      : null,
    homeTeam: game
      ? { id: game.homeTeamId, name: game.homeName, score: game.homeScore }
      : null,
  };
}

export function summarizeVenueAttendance(items: VenueDiaryItem[]): VenueAttendanceSummary {
  let wins = 0;
  let losses = 0;
  let draws = 0;

  for (const item of items) {
    if (item.result === "W") wins += 1;
    if (item.result === "L") losses += 1;
    if (item.result === "D") draws += 1;
  }

  const finalCount = wins + losses + draws;
  return {
    attendanceCount: items.length,
    wins,
    losses,
    draws,
    finalCount,
    winRate: finalCount > 0 ? wins / finalCount : null,
  };
}
