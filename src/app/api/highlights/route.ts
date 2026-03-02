import { NextRequest, NextResponse } from "next/server";

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

let cache: { data: any; ts: number } | null = null;
const CACHE_TTL = 30 * 60 * 1000;

function decodeHtml(s: string) {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&#x27;/g, "'");
}

export async function GET(req: NextRequest) {
  const team = req.nextUrl.searchParams.get("team");
  const query = team ? `KBO ${team} 하이라이트` : "KBO 프로야구 하이라이트";

  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return NextResponse.json(cache.data);
  }

  if (!YOUTUBE_API_KEY) {
    return NextResponse.json({ items: [], error: "YouTube API not configured" });
  }

  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=20&order=date&videoDuration=short&videoEmbeddable=true&key=${YOUTUBE_API_KEY}`
    );
    const data = await res.json();
    if (data.error) {
      return NextResponse.json({ items: [], error: data.error.message });
    }

    const items = (data.items || []).map((item: any) => ({
      id: item.id.videoId,
      title: decodeHtml(item.snippet.title),
      thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
      channel: item.snippet.channelTitle,
      publishedAt: item.snippet.publishedAt,
    }));

    const result = { items };
    cache = { data: result, ts: Date.now() };
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ items: [], error: e.message });
  }
}
