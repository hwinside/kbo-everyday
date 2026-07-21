import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthedRequest } from "@/lib/admin/pin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 크보팬 store identifiers (fixed per store listing).
const APPLE_APP_ID = "6765719087";
const ANDROID_APP_ID = "fan.keubo.app";
// iTunes RSS genre id for the Sports category.
const APPLE_SPORTS_GENRE = "6004";

// rank: 1-based position, or null when the app is outside the chart window.
// A whole ChartRank of null means the source fetch itself failed.
export type ChartRank = { rank: number | null; chartSize: number } | null;

export type AppRankingsPayload = {
  fetchedAt: string;
  ios: { sports: ChartRank; overall: ChartRank };
  android: { sports: ChartRank; overall: ChartRank };
};

type ItunesEntry = { id?: { attributes?: { "im:id"?: string } } };

// Apple's public RSS chart. The feed caps at 100 entries regardless of the
// requested limit, so "null rank" here means "outside the top ~100".
async function fetchAppleRank(genre?: string): Promise<ChartRank> {
  const url = genre
    ? `https://itunes.apple.com/kr/rss/topfreeapplications/limit=200/genre=${genre}/json`
    : `https://itunes.apple.com/kr/rss/topfreeapplications/limit=200/json`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`itunes rss ${res.status}`);
  const data = (await res.json()) as { feed?: { entry?: ItunesEntry | ItunesEntry[] } };
  const raw = data?.feed?.entry ?? [];
  const entries = Array.isArray(raw) ? raw : [raw];
  const idx = entries.findIndex((e) => e?.id?.attributes?.["im:id"] === APPLE_APP_ID);
  return { rank: idx >= 0 ? idx + 1 : null, chartSize: entries.length };
}

// Google Play has no official chart API; google-play-scraper reads the public
// top-charts cluster. num=200 is the practical chart window.
async function fetchPlayRank(category: "SPORTS" | "APPLICATION"): Promise<ChartRank> {
  const gplay = (await import("google-play-scraper")).default;
  const apps = (await gplay.list({
    category: category as never,
    collection: "TOP_FREE" as never,
    country: "kr",
    num: 200,
  })) as { appId: string }[];
  const idx = apps.findIndex((a) => a.appId === ANDROID_APP_ID);
  return { rank: idx >= 0 ? idx + 1 : null, chartSize: apps.length };
}

// Each chart is independent best-effort: one store/chart failing must not
// blank the other three, so failures collapse to null (UI shows 조회 실패).
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
