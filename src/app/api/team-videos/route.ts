import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { TEAMS } from "@/lib/constants/teams";
import type { YouTubeSearchItem } from "@/types/api";

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

interface TeamVideoItem {
  id: string;
  title: string;
  thumbnail: string | undefined;
  publishedAt: string;
  durationSeconds: number;
}

interface TeamVideoResult {
  items: TeamVideoItem[];
}

const cache = new Map<string, { data: TeamVideoResult; ts: number }>();

/** KST 기준 경기 시간대(11~24시)인지 확인 */
function isGameTimeKST(): boolean {
  const now = new Date();
  const kstHour = (now.getUTCHours() + 9) % 24;
  return kstHour >= 11;
}

/** 경기 시간대: 2시간, 비경기: 24시간 */
function getTeamVideosTTL(): number {
  return isGameTimeKST() ? 2 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
}

function decodeHtml(s: string) {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

function parseIsoDurationSeconds(iso: string): number {
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return 0;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function isShortVideo(title: string, durationSeconds: number): boolean {
  const normalized = title.toLowerCase();
  return durationSeconds > 0 && (
    durationSeconds <= 70 ||
    normalized.includes("#shorts") ||
    normalized.includes("shorts") ||
    title.includes("숏츠") ||
    title.includes("쇼츠")
  );
}

async function fetchVideoDetails(videoIds: string[]) {
  if (!YOUTUBE_API_KEY || videoIds.length === 0) {
    return new Map<string, { durationSeconds: number }>();
  }

  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${videoIds.join(",")}&key=${YOUTUBE_API_KEY}`
    );
    const data = await res.json();
    const map = new Map<string, { durationSeconds: number }>();

    for (const item of (data.items || [])) {
      map.set(item.id, {
        durationSeconds: parseIsoDurationSeconds(item.contentDetails?.duration || ""),
      });
    }

    return map;
  } catch {
    return new Map<string, { durationSeconds: number }>();
  }
}

export async function GET(req: NextRequest) {
  const teamSlug = req.nextUrl.searchParams.get("team");
  const type = req.nextUrl.searchParams.get("type") || "long"; // long | short
  if (!teamSlug) return NextResponse.json({ items: [] });

  const team = TEAMS.find(t => t.slug === teamSlug || t.shortName === teamSlug);
  if (!team?.youtubeChannelId) return NextResponse.json({ items: [] });

  const cacheKey = `${team.slug}-${type}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < getTeamVideosTTL()) {
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

    const rawItems: YouTubeSearchItem[] = data.items || [];
    const detailMap = await fetchVideoDetails(rawItems.map((item) => item.id.videoId).filter(Boolean));

    const items: TeamVideoItem[] = rawItems
      .filter((item) => {
        const detail = detailMap.get(item.id.videoId);
        if (!detail) return false;
        const short = isShortVideo(decodeHtml(item.snippet.title), detail.durationSeconds);
        return type === "short" ? short : !short;
      })
      .map((item: YouTubeSearchItem) => ({
        id: item.id.videoId,
        title: decodeHtml(item.snippet.title),
        thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.medium?.url,
        publishedAt: item.snippet.publishedAt,
        durationSeconds: detailMap.get(item.id.videoId)?.durationSeconds ?? 0,
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
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return NextResponse.json({ items: [] });
  try {
    const supabase = supabaseAdmin;
    const { data } = await supabase
      .from("highlights")
      .select("video_id, title, thumbnail, published_at")
      .eq("team", teamShortName)
      .order("published_at", { ascending: false })
      .limit(type === "short" ? 20 : 10);

    if (data && data.length > 0) {
      const filtered = data.filter((v) => {
        const short = isShortVideo(v.title, 0);
        return type === "short" ? short : !short;
      });

      return NextResponse.json({
        items: filtered.map((v) => ({
          id: v.video_id,
          title: v.title,
          thumbnail: v.thumbnail,
          publishedAt: v.published_at,
          durationSeconds: 0,
        })),
      });
    }
  } catch { /* ignore */ }
  return NextResponse.json({ items: [] });
}
