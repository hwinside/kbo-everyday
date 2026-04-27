/**
 * YouTube Data API shared helpers
 * Multi-key fallback: YOUTUBE_API_KEY → _2 → _3 (rotate on 403)
 */

/** Collect all available API keys (skip empty) */
function getApiKeys(): string[] {
  return [
    process.env.YOUTUBE_API_KEY,
    process.env.YOUTUBE_API_KEY_2,
    process.env.YOUTUBE_API_KEY_3,
  ].filter((k): k is string => !!k);
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
 * On 403 (quota exceeded), rotates to the next API key.
 * Stops only when all keys are exhausted.
 */
export async function fetchVideoDurations(
  videoIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const keys = getApiKeys();
  if (keys.length === 0 || videoIds.length === 0) return result;

  let keyIdx = 0;

  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    let fetched = false;

    while (!fetched && keyIdx < keys.length) {
      try {
        const res = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${batch.join(",")}&key=${keys[keyIdx]}`,
        );
        if (res.status === 403) {
          keyIdx++; // rotate to next key
          continue;
        }
        if (!res.ok) {
          fetched = true; // skip this batch, move on
          break;
        }
        const data = await res.json();
        for (const item of data.items || []) {
          const dur = parseIsoDuration(
            item.contentDetails?.duration || "",
          );
          result.set(item.id, dur);
        }
        fetched = true;
      } catch {
        fetched = true; // network error — skip batch
      }
    }

    if (keyIdx >= keys.length) break; // all keys exhausted
  }
  return result;
}
