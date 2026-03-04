import { NextRequest, NextResponse } from "next/server";

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

const cache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL = 30 * 60 * 1000;

function decodeHtml(s: string) {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&#x27;/g, "'");
}

export async function GET(req: NextRequest) {
  const team = req.nextUrl.searchParams.get("team");
  const q = req.nextUrl.searchParams.get("q");
  const query = q || (team ? `KBO ${team} 하이라이트` : "KBO 프로야구 하이라이트");

  const cached = cache.get(query);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json(cached.data);
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
    if (result.items?.length > 0) cache.set(query, { data: result, ts: Date.now() });
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ items: [], error: e.message });
  }
}
