import { NextRequest, NextResponse } from "next/server";
import {
  getPlayerTodayGameRouteResult,
  type PlayerTodayGameResponse,
} from "@/lib/services/player-today-game";

export type { PlayerTodayGameResponse };

export async function GET(req: NextRequest) {
  const result = await getPlayerTodayGameRouteResult({
    teamId: parseInt(req.nextUrl.searchParams.get("team") ?? "", 10),
    name: req.nextUrl.searchParams.get("name") ?? "",
    pos: req.nextUrl.searchParams.get("pos") ?? "",
  });
  return NextResponse.json(result.body, {
    status: result.status,
    headers: result.headers,
  });
}
