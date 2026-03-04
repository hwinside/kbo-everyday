import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

const memCache = new Map<string, { data: any; ts: number }>();
const MEM_TTL = 4 * 60 * 60 * 1000;

function decodeHtml(s: string) {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

export async function GET(req: NextRequest) {
  const team = req.nextUrl.searchParams.get("team") || "_ALL";

  // 1. Supabase (Cron이 채운 데이터)
  if (SUPABASE_URL) {
    try {
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
      const { data } = await supabase
        .from("highlights")
        .select("video_id, title, thumbnail, channel, published_at")
        .eq("team", team)
        .order("published_at", { ascending: false })
        .limit(30);

      if (data && data.length > 0) {
        return NextResponse.json({
          items: data.map((v) => ({
            id: v.video_id, title: v.title, thumbnail: v.thumbnail,
            channel: v.channel, publishedAt: v.published_at,
          })),
        });
      }
    } catch { /* fallback */ }
  }

  // 2. 메모리 캐시
  const cached = memCache.get(team);
  if (cached && Date.now() - cached.ts < MEM_TTL) {
    return NextResponse.json(cached.data);
  }

  // 3. YouTube 직접 (최후 수단)
  if (!YOUTUBE_API_KEY) return NextResponse.json({ items: [] });
  try {
    const query = team === "_ALL" ? "KBO 프로야구 하이라이트" : `${team} 하이라이트`;
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=30&order=date&videoDuration=short&videoEmbeddable=true&key=${YOUTUBE_API_KEY}`
    );
    const data = await res.json();
    if (data.error) return NextResponse.json({ items: [] });
    const items = (data.items || []).map((item: any) => ({
      id: item.id.videoId, title: decodeHtml(item.snippet.title),
      thumbnail: item.snippet.thumbnails?.high?.url, channel: item.snippet.channelTitle,
      publishedAt: item.snippet.publishedAt,
    }));
    const result = { items };
    if (items.length > 0) memCache.set(team, { data: result, ts: Date.now() });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ items: [] });
  }
}
