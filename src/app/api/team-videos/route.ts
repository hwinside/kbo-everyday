import { NextRequest, NextResponse } from "next/server";
import { signContentView } from "@/lib/content-views/sign";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { TEAMS } from "@/lib/constants/teams";
import {
  recordQuota,
  countSearch,
  countVideoList,
  withQuotaRecording,
  type QuotaCounter,
} from "@/lib/video/youtube-quota";
import type { YouTubeSearchItem } from "@/types/api";

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

interface TeamVideoItem {
  id: string;
  title: string;
  thumbnail: string | undefined;
  publishedAt: string;
  durationSeconds: number;
  viewToken?: string;
}

/** 조회수 서명 발급 — 서버가 실제 목록에 내보낸 영상만 /api/content-views/view 증가 가능(임의 id 차단). */
function withViewTokens(items: TeamVideoItem[]): TeamVideoItem[] {
  return items.map((item) => {
    const viewToken = item.id ? signContentView("shorts", item.id) : null;
    return viewToken ? { ...item, viewToken } : item;
  });
}

interface TeamVideoResult {
  items: TeamVideoItem[];
}

const cache = new Map<string, { data: TeamVideoResult; ts: number }>();

/** 실제 시도한 quota units 를 원장에 durable 기록 + RPC 오류 노출(throw 안 함). */
async function recordQuotaUnits(units: number): Promise<void> {
  const rec = await recordQuota(supabaseAdmin, units);
  if (rec.error) {
    console.warn(`[team-videos] quota 원장 기록 실패(units=${units}): ${rec.error}`);
  }
}

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

async function fetchVideoDetails(videoIds: string[], counter?: QuotaCounter) {
  if (!YOUTUBE_API_KEY || videoIds.length === 0) {
    return new Map<string, { durationSeconds: number }>();
  }

  try {
    countVideoList(counter); // videos.list 실제 시도(1 unit)
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
    // counter 를 try 밖(withQuotaRecording 내부)에서 생성하고, fetch/res.json() 가 throw 해도
    // finally 공통 종료 경로에서 이미 소비된 search(100) 를 정확히 1회 기록(삼순 #709 3번).
    return await withQuotaRecording(recordQuotaUnits, async (quota) => {
      const duration = type === "short" ? "short" : "medium";
      const maxResults = type === "short" ? 20 : 10;
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${team.youtubeChannelId}&type=video&videoDuration=${duration}&maxResults=${maxResults}&order=date&key=${YOUTUBE_API_KEY}`;
      countSearch(quota); // search.list 실제 시도(100 units)
      const res = await fetch(url);
      const data = await res.json();

      if (data.error) {
        // search 는 이미 시도됨 — finally 가 소비분을 durable 기록.
        return fallback(team.shortName, type);
      }

      const rawItems: YouTubeSearchItem[] = data.items || [];
      const detailMap = await fetchVideoDetails(rawItems.map((item) => item.id.videoId).filter(Boolean), quota);

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

      // 조회수 서명 발급 — 서버가 실제 목록에 내보낸 영상만 /api/content-views/view 증가 가능.
      const result = { items: withViewTokens(items) };
      cache.set(cacheKey, { data: result, ts: Date.now() });
      return NextResponse.json(result);
    });
  } catch {
    // fetch/json fault — finally 가 이미 search 100 units 기록 후 예외 전파 → fallback.
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
        items: withViewTokens(filtered.map((v) => ({
          id: v.video_id,
          title: v.title,
          thumbnail: v.thumbnail ?? undefined,
          publishedAt: v.published_at,
          durationSeconds: 0,
        }))),
      });
    }
  } catch { /* ignore */ }
  return NextResponse.json({ items: [] });
}
