/**
 * YouTube Data API shared helpers
 * Uses a single production key. Do not rotate keys to bypass quota limits.
 */

import type { RssVideoEntry } from "./rss-parser";

function getApiKey(): string | null {
  return process.env.YOUTUBE_API_KEY || null;
}

/** Parse ISO 8601 duration (PT1H2M3S) → seconds */
export function parseIsoDuration(iso: string): number {
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return 0;
  return (
    Number(match[1] || 0) * 3600 +
    Number(match[2] || 0) * 60 +
    Number(match[3] || 0)
  );
}

/**
 * Batch-fetch video durations via YouTube Data API.
 * `videos.list` costs 1 quota unit per call, max 50 IDs per call.
 * On 403 (quota exceeded/forbidden), stops instead of rotating keys.
 */
export async function fetchVideoDurations(
  videoIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const apiKey = getApiKey();
  if (!apiKey || videoIds.length === 0) return result;

  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    try {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${batch.join(",")}&key=${apiKey}`,
      );
      if (res.status === 403) break;
      if (!res.ok) continue;
      const data = await res.json();
      for (const item of data.items || []) {
        const dur = parseIsoDuration(
          item.contentDetails?.duration || "",
        );
        result.set(item.id, dur);
      }
    } catch {
      // network error — skip batch
    }
  }
  return result;
}

/**
 * Fallback fetch for a channel's recent uploads via Data API `playlistItems.list`.
 * YouTube blocks RSS requests from datacenter IPs (Vercel) intermittently while
 * the same channel still serves RSS fine from residential IPs. This is the
 * fallback path called only when `fetchChannelRss` throws.
 *
 * Cost: 1 quota unit per call. UC{xxx} → UU{xxx} converts a channel ID to its
 * uploads playlist ID (YouTube guarantee).
 *
 * Returns:
 *   - `RssVideoEntry[]` on success (possibly empty if channel has no uploads)
 *   - `null` on failure (network, 403, non-2xx other than 404)
 *   A 404 is treated as "no items" so transient/dead playlists don't keep the
 *   channel in the error bucket.
 */
export async function fetchChannelUploadsViaApi(
  channelId: string,
  maxResults = 15,
): Promise<RssVideoEntry[] | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;
  if (!channelId.startsWith("UC")) return null;

  const playlistId = `UU${channelId.slice(2)}`;
  const limit = Math.min(Math.max(maxResults, 1), 50);

  try {
    const url =
      `https://www.googleapis.com/youtube/v3/playlistItems` +
      `?part=snippet,contentDetails&playlistId=${playlistId}` +
      `&maxResults=${limit}&key=${apiKey}`;
    const res = await fetch(url);
    if (res.status === 403) return null;
    if (res.status === 404) return [];
    if (!res.ok) return null;
    const data = await res.json();
    const items = (data.items ?? []) as Array<{
      snippet?: {
        title?: string;
        channelTitle?: string;
        publishedAt?: string;
        thumbnails?: {
          maxres?: { url?: string };
          high?: { url?: string };
          medium?: { url?: string };
          default?: { url?: string };
        };
      };
      contentDetails?: { videoId?: string; videoPublishedAt?: string };
    }>;
    const out: RssVideoEntry[] = [];
    for (const it of items) {
      const videoId = it.contentDetails?.videoId;
      const publishedAt =
        it.contentDetails?.videoPublishedAt ?? it.snippet?.publishedAt;
      if (!videoId || !publishedAt) continue;
      const t = it.snippet?.thumbnails;
      const thumbnail =
        t?.maxres?.url ?? t?.high?.url ?? t?.medium?.url ?? t?.default?.url ?? "";
      out.push({
        video_id: videoId,
        title: it.snippet?.title ?? "",
        thumbnail,
        channel: it.snippet?.channelTitle ?? "",
        channel_id: channelId,
        published_at: publishedAt,
      });
    }
    return out;
  } catch {
    return null;
  }
}
