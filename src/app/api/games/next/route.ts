import { NextRequest, NextResponse } from "next/server";
import { fetchSharedDateGames } from "@/lib/games/shared-date-games";
import { TEAMS } from "@/lib/constants/teams";
import { scanDates, scanNextGame } from "@/lib/games/next-game-scan";

// At most 15 sequential dates through the existing date-only CDN cache.
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const dates = scanDates(params.get("from") ?? "", params.get("to") ?? "");
  const teamId = Number(params.get("teamId"));
  const mode = params.get("mode") ?? "active";
  const excludeId = params.get("excludeId") ?? "";
  if (!dates || !TEAMS.some((team) => team.id === teamId) ||
      !["active", "scheduled"].includes(mode) || excludeId.length > 40) {
    return NextResponse.json({ error: "Invalid next-game scan parameters" }, { status: 400 });
  }
  try {
    const result = await scanNextGame({
      dates,
      signal: request.signal,
      fetchGames: (date) => fetchSharedDateGames(request.nextUrl.origin, date),
      matches: (game) => (game.homeTeamId === teamId || game.awayTeamId === teamId) &&
        game.gameId !== excludeId &&
        (game.status === "scheduled" || (mode === "active" && game.status === "live")),
    });
    // Never cache a partial scan as a definitive next game / no-game result.
    // No long-lived negative cache: newly announced schedules are picked up normally.
    return NextResponse.json(result, {
      headers: { "Cache-Control": result.failedDates.length ? "no-store" : "public, s-maxage=30, stale-while-revalidate=60" },
    });
  } catch {
    return NextResponse.json({ error: "Next-game scan interrupted" }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
}
