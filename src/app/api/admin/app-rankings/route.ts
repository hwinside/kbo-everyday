import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthedRequest } from "@/lib/admin/pin";
import {
  rankFromItunesFeed,
  rankFromPlayList,
  withTimeout,
  type ChartRank,
} from "@/lib/admin/app-rankings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 크보팬 store identifiers (fixed per store listing).
const APPLE_APP_ID = "6765719087";
const ANDROID_APP_ID = "fan.keubo.app";
// iTunes RSS genre id for the Sports category.
const APPLE_SPORTS_GENRE = "6004";
// Per-chart budget so one hanging source can't drag the whole response to the
// 60s function limit — worst case the response returns in ~15s with the slow
// chart degraded to 조회 실패.
const CHART_TIMEOUT_MS = 15_000;

export type AppRankingsPayload = {
  fetchedAt: string;
  ios: { sports: ChartRank; overall: ChartRank };
  android: { sports: ChartRank; overall: ChartRank };
};

// Apple's public RSS chart. The feed caps at 100 entries regardless of the
// requested limit, so "null rank" here means "outside the top ~100".
async function fetchAppleRank(genre?: string): Promise<ChartRank> {
  const url = genre
    ? `https://itunes.apple.com/kr/rss/topfreeapplications/limit=200/genre=${genre}/json`
    : `https://itunes.apple.com/kr/rss/topfreeapplications/limit=200/json`;
  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(CHART_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`itunes rss ${res.status}`);
  return rankFromItunesFeed(await res.json(), APPLE_APP_ID);
}

// Google Play has no official chart API; google-play-scraper reads the public
// top-charts cluster. num=200 is the practical chart window. The scraper has
// no abort support, so the wait (not the request) is capped via withTimeout.
async function fetchPlayRank(category: "SPORTS" | "APPLICATION"): Promise<ChartRank> {
  const gplay = (await import("google-play-scraper")).default;
  const apps = await withTimeout(
    gplay.list({
      category: category as never,
      collection: "TOP_FREE" as never,
      country: "kr",
      num: 200,
    }),
    CHART_TIMEOUT_MS,
    `play ${category}`,
  );
  return rankFromPlayList(apps, ANDROID_APP_ID);
}

// Each chart is independent best-effort: one store/chart failing (timeout,
// non-200, empty/reshaped payload) must not blank the other three, so
// failures collapse to null (UI shows 조회 실패).
async function safe(p: Promise<ChartRank>): Promise<ChartRank> {
  try {
    return await p;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthedRequest(request))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const [iosSports, iosOverall, aosSports, aosOverall] = await Promise.all([
    safe(fetchAppleRank(APPLE_SPORTS_GENRE)),
    safe(fetchAppleRank()),
    safe(fetchPlayRank("SPORTS")),
    safe(fetchPlayRank("APPLICATION")),
  ]);

  const payload: AppRankingsPayload = {
    fetchedAt: new Date().toISOString(),
    ios: { sports: iosSports, overall: iosOverall },
    android: { sports: aosSports, overall: aosOverall },
  };
  return NextResponse.json(payload);
}
