import { NextRequest, NextResponse } from "next/server";
import type { KboRawGame } from "@/types/api";

/**
 * Warm up the in-memory prevState cache of /api/game-events for every
 * currently-live KBO game. Without this, the cache is only populated when
 * a client opens a game page, so any plays that happen between the actual
 * first pitch and the first client visit are emitted as `game_start` only —
 * the BoxScore stat lines accrued in that window never become events.
 *
 * Self-fetches the same game-events route used by clients so the warm-up
 * traverses the exact diff path; no parallel logic to keep in sync.
 */

const CRON_SECRET = process.env.CRON_SECRET || "";
const KBO_MAIN = "https://www.koreabaseball.com/ws/Main.asmx";

function getKSTDateStr(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10).replace(/-/g, "");
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const date = getKSTDateStr();

  const liveRes = await fetch(`${KBO_MAIN}/GetKboGameList`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
    },
    body: `leId=1&srId=0,1,3,4,5,7,8,9&date=${date}`,
    cache: "no-store",
  }).then(r => (r.ok ? r.json() : null)).catch(() => null);

  const games: KboRawGame[] = liveRes?.game || [];
  const liveGameIds = games
    .filter(g => g.GAME_STATE_SC === "2" && g.G_ID)
    .map(g => g.G_ID as string);

  // Self-fetch to traverse the same generateEvents path the client takes.
  const baseUrl = req.nextUrl.origin;
  const results = await Promise.allSettled(
    liveGameIds.map(gameId =>
      fetch(`${baseUrl}/api/game-events?gameId=${gameId}`, {
        cache: "no-store",
        headers: { "User-Agent": "kbo-everyday-warmup/1.0" },
      }).then(async r => ({
        gameId,
        ok: r.ok,
        status: r.status,
        eventCount: r.ok ? ((await r.json())?.events?.length ?? 0) : null,
      })),
    ),
  );

  return NextResponse.json({
    date,
    polled: liveGameIds.length,
    liveGameIds,
    results: results.map(r =>
      r.status === "fulfilled" ? r.value : { error: String(r.reason) },
    ),
  });
}
