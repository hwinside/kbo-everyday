import { NextRequest, NextResponse } from "next/server";
import { getPlayerGameLogsRouteResult } from "@/lib/services/player-game-logs";

export const dynamic = "force-dynamic";
export { getPlayerGameLogsRouteResult };

export async function GET(request: NextRequest) {
  const searchParams = new URL(request.url).searchParams;
  const result = await getPlayerGameLogsRouteResult(
    searchParams.get("id"),
    searchParams.get("pos") ?? "",
  );
  return NextResponse.json(result.body, {
    status: result.status,
    headers: result.headers,
  });
}
