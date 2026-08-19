import { NextRequest, NextResponse } from "next/server";
import {
  getPlayerStatsRouteResult,
  type PlayerDetailStats,
} from "@/lib/services/player-stats";

export { getPlayerStatsRouteResult };
export type { PlayerDetailStats };

export async function GET(req: NextRequest) {
  const result = await getPlayerStatsRouteResult(
    req.nextUrl.searchParams.get("id"),
    req.nextUrl.searchParams.get("pos") || "타자",
  );
  return NextResponse.json(result.body, {
    status: result.status,
    headers: result.headers,
  });
}
