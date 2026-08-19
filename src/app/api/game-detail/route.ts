import { NextRequest, NextResponse, after } from "next/server";
import { jsonWithETag } from "@/lib/http/conditional";
import { GAME_ID_FORMAT_HINT, isCanonicalKboGameId } from "@/lib/game/game-id";
import {
  fetchNaverDetailLineup,
  fetchNaverRecord,
  getGameDetailRouteResult,
  setGameDetailDegradationObserverForTest,
  USER_FACING_GAME_DETAIL_DEADLINE_MS,
  type BatterRecord,
  type GameDetailResponse,
  type LineupEntry,
  type PitcherRecord,
} from "@/lib/services/game-detail";

// ⚠️ main 에서 route 가 내보내던 helper 전수 재-export(구현만 service 로 이동).
//   기존 게이트·소비처가 route 경로로 import 하므로 빠뜨리면 하류가 죽는다.
export {
  fetchNaverDetailLineup,
  fetchNaverRecord,
  getGameDetailRouteResult,
  setGameDetailDegradationObserverForTest,
  USER_FACING_GAME_DETAIL_DEADLINE_MS,
};
export type { BatterRecord, GameDetailResponse, LineupEntry, PitcherRecord };

function scheduleDeferred(effect: () => Promise<void>): void {
  try {
    after(() => effect());
  } catch {
    void effect().catch(() => undefined);
  }
}

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
    onDeferredEffect: (effect) => {
      scheduleDeferred(() => effect());
    },
  });

  return jsonWithETag(req, response);
}
