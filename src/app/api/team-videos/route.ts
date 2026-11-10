import { NextRequest, NextResponse } from "next/server";
import { signContentView } from "@/lib/content-views/sign";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { TEAMS } from "@/lib/constants/teams";
import {
  recordQuota,
  countPlaylistItems,
  countVideoList,
  withQuotaRecording,
  type QuotaCounter,
} from "@/lib/video/youtube-quota";
import { fetchChannelUploadsViaApi } from "@/lib/video/youtube-api";
import { selectTeamVideoItems } from "@/lib/video/team-videos-select";

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
      // channelId를 이미 알므로 search.list(100 units) 대신 uploads 플레이리스트를
      // playlistItems.list(1 unit)로 가져온다(약 50배 quota 절감). 종류별 videoDuration
      // 필터링은 uploads가 석임 혼재이므로 아래 videos.list duration 기준으로 유지.
      // uploads는 short/long 미구분 단일 목록이라 필터 후 충분하도록 50개까지 수집.
      const targetCount = type === "short" ? 20 : 10;
      countPlaylistItems(quota); // playlistItems.list 실제 시도(1 unit)
      const uploads = await fetchChannelUploadsViaApi(team.youtubeChannelId, 50);

      if (!uploads) {
        // playlistItems 실패(403/network/non-2xx) — finally 가 소비분을 durable 기록.
        return fallback(team.shortName, type);
      }

      const detailMap = await fetchVideoDetails(uploads.map((it) => it.video_id).filter(Boolean), quota);

      const items: TeamVideoItem[] = selectTeamVideoItems(
        uploads,
        detailMap,
        type === "short" ? "short" : "long",
        targetCount,
      );

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
