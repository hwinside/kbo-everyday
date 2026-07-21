// Pure chart-rank parsing for the admin app-rankings card.
// Fail-close contract: an empty or schema-mismatched chart payload throws
// (→ the route degrades that chart to "조회 실패"); "rank: null" strictly
// means "chart parsed fine but our app is outside the window".

export type ChartRankValue = { rank: number | null; chartSize: number };
// null = that source fetch/parse failed (UI shows 조회 실패).
export type ChartRank = ChartRankValue | null;

type ItunesEntry = { id?: { attributes?: { "im:id"?: string } } };

export function rankFromItunesFeed(data: unknown, appleAppId: string): ChartRankValue {
  const raw = (data as { feed?: { entry?: ItunesEntry | ItunesEntry[] } } | null)?.feed?.entry;
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const withId = entries.filter((e) => typeof e?.id?.attributes?.["im:id"] === "string");
  // Fail-close: a top chart is never legitimately empty — 0 parsable entries
  // means the feed is broken/reshaped, not that we're unranked.
  if (withId.length === 0) throw new Error("itunes feed empty or schema mismatch");
  const idx = withId.findIndex((e) => e.id!.attributes!["im:id"] === appleAppId);
  return { rank: idx >= 0 ? idx + 1 : null, chartSize: withId.length };
}

export function rankFromPlayList(apps: unknown, androidAppId: string): ChartRankValue {
  const list = Array.isArray(apps) ? apps : [];
  const withId = list.filter(
    (a) => typeof (a as { appId?: unknown } | null)?.appId === "string",
  ) as { appId: string }[];
  if (withId.length === 0) throw new Error("play chart empty or schema mismatch");
  const idx = withId.findIndex((a) => a.appId === androidAppId);
  return { rank: idx >= 0 ? idx + 1 : null, chartSize: withId.length };
}

// Bounded wait for sources without AbortSignal support (google-play-scraper).
// The underlying request may keep running; we only cap how long we wait.
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
