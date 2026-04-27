/**
 * YouTube Data API shared helpers
 */

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

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
 * Stops on quota error (403) to avoid burning remaining budget.
 */
export async function fetchVideoDurations(
  videoIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!YOUTUBE_API_KEY || videoIds.length === 0) return result;

  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    try {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${batch.join(",")}&key=${YOUTUBE_API_KEY}`,
      );
      if (!res.ok) {
        if (res.status === 403) break; // quota exceeded — stop
        continue;
      }
      const data = await res.json();
      for (const item of data.items || []) {
        const dur = parseIsoDuration(
          item.contentDetails?.duration || "",
        );
        result.set(item.id, dur);
      }
    } catch {
      // Network error — continue with next batch
    }
  }
  return result;
}
