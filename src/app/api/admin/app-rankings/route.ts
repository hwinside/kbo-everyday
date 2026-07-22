import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthedRequest } from "@/lib/admin/pin";
import {
  rankFromAppleChartHtml,
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
// Apple genre ids: 36 = all apps, 6004 = Sports.
const APPLE_ALL_APPS_GENRE = "36";
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

// Apple's public chart page embeds all 200 ranks in serialized-server-data;
// its public RSS feed currently truncates the same chart at 100.
async function fetchAppleRank(genre: string): Promise<ChartRank> {
  const signal = AbortSignal.timeout(CHART_TIMEOUT_MS);
  const chartUrl = `https://apps.apple.com/kr/iphone/charts/${genre}?chart=top-free`;
  try {
    const res = await fetch(chartUrl, {
      cache: "no-store",
      headers: { "user-agent": "Mozilla/5.0 (compatible; KeuboFanAdmin/1.0)" },
      signal,
    });
    if (!res.ok) throw new Error(`apple chart ${res.status}`);
    return rankFromAppleChartHtml(await res.text(), APPLE_APP_ID);
  } catch {
    // Continue to the RSS fallback below. The same AbortSignal preserves the
    // original 15-second per-chart deadline across both attempts.
  }

  // Best-effort fallback: RSS can still recover an in-range rank. Absence in
  // its 100-row window is not enough to claim the app is outside the top 200.
  const rssUrl = `https://itunes.apple.com/kr/rss/topfreeapplications/limit=200/genre=${genre}/json`;
  const rss = await fetch(rssUrl, {
    cache: "no-store",
    signal,
  });
  if (!rss.ok) throw new Error(`apple RSS ${rss.status}`);
  const fallback = rankFromItunesFeed(await rss.json(), APPLE_APP_ID);
  if (fallback.rank === null)
    throw new Error("apple web failed and RSS top-100 is inconclusive");
  return fallback;
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
    safe(fetchAppleRank(APPLE_ALL_APPS_GENRE)),
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
