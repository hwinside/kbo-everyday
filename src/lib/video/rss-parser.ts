/**
 * YouTube RSS feed 파서 (quota 0)
 * B안 Phase 1: videos 테이블 수집용 공통 유틸
 */

export interface RssVideoEntry {
  video_id: string;
  title: string;
  thumbnail: string;
  channel: string;
  channel_id: string;
  published_at: string; // ISO
}

function decodeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/** YouTube 채널 RSS 피드 최근 15개 영상 */
export async function fetchChannelRss(channelId: string): Promise<RssVideoEntry[]> {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
  const xml = await res.text();

  const entries: RssVideoEntry[] = [];
  const entryBlocks = xml.split("<entry>").slice(1);

  for (const block of entryBlocks) {
    const videoId = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1] || "";
    const title = decodeHtml(block.match(/<title>([^<]+)<\/title>/)?.[1] || "");
    const thumbnail = block.match(/<media:thumbnail url="([^"]+)"/)?.[1] || "";
    const channel = decodeHtml(block.match(/<name>([^<]+)<\/name>/)?.[1] || "");
    const publishedAt = block.match(/<published>([^<]+)<\/published>/)?.[1] || "";

    if (videoId && publishedAt) {
      entries.push({
        video_id: videoId,
        title,
        thumbnail,
        channel,
        channel_id: channelId,
        published_at: publishedAt,
      });
    }
  }

  return entries;
}
