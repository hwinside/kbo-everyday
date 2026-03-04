import { NextRequest, NextResponse } from "next/server";
import { TEAMS } from "@/lib/constants/teams";

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const cache = new Map<string, { data: any; ts: number }>();
const TTL = 4 * 60 * 60 * 1000;

function decodeHtml(s: string) {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

export async function GET(req: NextRequest) {
  const teamSlug = req.nextUrl.searchParams.get("team");
  if (!teamSlug) return NextResponse.json({ items: [] });

  const team = TEAMS.find(t => t.slug === teamSlug || t.shortName === teamSlug);
  if (!team?.youtubeChannelId) return NextResponse.json({ items: [] });

  const cacheKey = team.slug;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TTL) {
    return NextResponse.json(cached.data);
  }

  if (!YOUTUBE_API_KEY) return NextResponse.json({ items: [] });

  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${team.youtubeChannelId}&type=video&maxResults=10&order=date&key=${YOUTUBE_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) return NextResponse.json({ items: [] });

    const items = (data.items || []).map((item: any) => ({
      id: item.id.videoId,
      title: decodeHtml(item.snippet.title),
      thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.medium?.url,
      publishedAt: item.snippet.publishedAt,
    }));

    const result = { items, channelName: team.name };
    if (items.length > 0) cache.set(cacheKey, { data: result, ts: Date.now() });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ items: [] });
  }
}
