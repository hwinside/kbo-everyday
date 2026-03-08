import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { TEAMS } from "@/lib/constants/teams";
import type { YouTubeSearchItem } from "@/types/api";

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

interface TeamVideoItem {
  id: string;
  title: string;
  thumbnail: string | undefined;
  publishedAt: string;
}

interface TeamVideoResult {
  items: TeamVideoItem[];
}

const cache = new Map<string, { data: TeamVideoResult; ts: number }>();
const TTL = 24 * 60 * 60 * 1000; // 24hr

function decodeHtml(s: string) {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

export async function GET(req: NextRequest) {
  const teamSlug = req.nextUrl.searchParams.get("team");
  const type = req.nextUrl.searchParams.get("type") || "long"; // long | short
  if (!teamSlug) return NextResponse.json({ items: [] });

  const team = TEAMS.find(t => t.slug === teamSlug || t.shortName === teamSlug);
  if (!team?.youtubeChannelId) return NextResponse.json({ items: [] });

  const cacheKey = `${team.slug}-${type}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TTL) {
    return NextResponse.json(cached.data);
  }

  if (!YOUTUBE_API_KEY) return fallback(team.shortName, type);

  try {
    const duration = type === "short" ? "short" : "medium";
    const maxResults = type === "short" ? 20 : 10;
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${team.youtubeChannelId}&type=video&videoDuration=${duration}&maxResults=${maxResults}&order=date&key=${YOUTUBE_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) return fallback(team.shortName, type);

    const items: TeamVideoItem[] = (data.items || []).map((item: YouTubeSearchItem) => ({
      id: item.id.videoId,
      title: decodeHtml(item.snippet.title),
      thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.medium?.url,
      publishedAt: item.snippet.publishedAt,
    }));

    if (items.length === 0) return fallback(team.shortName, type);

    const result = { items };
    cache.set(cacheKey, { data: result, ts: Date.now() });
    return NextResponse.json(result);
  } catch {
    return fallback(team.shortName, type);
  }
}

// YouTube API 실패 시 highlights 테이블에서 같은 팀 데이터로 fallback
async function fallback(teamShortName: string, type: string) {
  if (!SUPABASE_URL) return NextResponse.json({ items: [] });
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { data } = await supabase
      .from("highlights")
      .select("video_id, title, thumbnail, published_at")
      .eq("team", teamShortName)
      .order("published_at", { ascending: false })
      .limit(type === "short" ? 20 : 10);

    if (data && data.length > 0) {
      return NextResponse.json({
        items: data.map((v) => ({
          id: v.video_id,
          title: v.title,
          thumbnail: v.thumbnail,
          publishedAt: v.published_at,
        })),
      });
    }
  } catch { /* ignore */ }
  return NextResponse.json({ items: [] });
}
