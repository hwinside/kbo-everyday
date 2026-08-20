import { NextRequest, NextResponse, after } from "next/server";
import {
  getPlayerTodayGameRouteResult,
  type PlayerTodayGameResponse,
} from "@/lib/services/player-today-game";

export type { PlayerTodayGameResponse };

function scheduleDeferred(effect: () => Promise<void>): void {
  try {
    after(() => effect());
  } catch {
    void effect().catch(() => undefined);
  }
}

export async function GET(req: NextRequest) {
  const result = await getPlayerTodayGameRouteResult({
    teamId: parseInt(req.nextUrl.searchParams.get("team") ?? "", 10),
    name: req.nextUrl.searchParams.get("name") ?? "",
    pos: req.nextUrl.searchParams.get("pos") ?? "",
    onDeferredEffect: (effect) => {
      scheduleDeferred(() => effect());
    },
  });
  return NextResponse.json(result.body, {
    status: result.status,
    headers: result.headers,
  });
}
