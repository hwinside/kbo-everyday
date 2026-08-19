import { NextRequest, NextResponse } from "next/server";
import { jsonWithETag } from "@/lib/http/conditional";
import { GAME_ID_FORMAT_HINT, isCanonicalKboGameId } from "@/lib/game/game-id";
import {
  fetchNaverRecord,
  getGameDetailRouteResult,
  setGameDetailDegradationObserverForTest,
  USER_FACING_GAME_DETAIL_DEADLINE_MS,
  type BatterRecord,
  type GameDetailResponse,
  type LineupEntry,
  type PitcherRecord,
} from "@/lib/services/game-detail";

export {
  fetchNaverRecord,
  getGameDetailRouteResult,
  setGameDetailDegradationObserverForTest,
  USER_FACING_GAME_DETAIL_DEADLINE_MS,
};
export type { BatterRecord, GameDetailResponse, LineupEntry, PitcherRecord };

export async function GET(req: NextRequest) {
  // Bounded fallback의 shared absolute deadline 계약은 service 구현에서 유지된다: signal: deadlineSignal
  const gameId = req.nextUrl.searchParams.get("gameId");
  if (!gameId) {
    return NextResponse.json({ error: "gameId is required" }, { status: 400 });
  }
  if (!isCanonicalKboGameId(gameId)) {
    return NextResponse.json(
      { error: "invalid gameId format", hint: GAME_ID_FORMAT_HINT },
      { status: 400 },
    );
  }

  const response = await getGameDetailRouteResult({
    gameId,
    seasonId: req.nextUrl.searchParams.get("seasonId") || undefined,
    overrideSrId: req.nextUrl.searchParams.get("srId"),
    sourceAtMs: Date.now(),
  });

  return jsonWithETag(req, response);
}
