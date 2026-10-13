import { after, NextRequest, NextResponse } from "next/server";
import { collectTodayGameBatch, parseTodayGameBatch } from "@/lib/player-today-game-batch";
import { getPlayerTodayGameRouteResult } from "@/lib/services/player-today-game";

export async function GET(request: NextRequest) {
  const values = request.nextUrl.searchParams.getAll("players");
  const players = values.length === 1 ? parseTodayGameBatch(values[0]) : null;
  if (!players) {
    return NextResponse.json({ error: "invalid_players" }, {
      status: 400,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  }
  const result = await collectTodayGameBatch(players, (player) => getPlayerTodayGameRouteResult({
    teamId: player.teamId,
    name: player.name,
    pos: player.pos,
    onDeferredEffect: (effect) => {
      try {
        after(() => effect());
      } catch {
        void effect().catch(() => undefined);
      }
    },
  }));
  return NextResponse.json(result.body, { headers: result.headers });
}
