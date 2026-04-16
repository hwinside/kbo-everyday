import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { TEAMS } from "@/lib/constants/teams";
import type { YouTubeSearchItem, HighlightVideo } from "@/types/api";

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

interface HighlightResult {
  items: HighlightVideo[];
}

const memCache = new Map<string, { data: HighlightResult; ts: number }>();

/** KST 기준 경기 시간대(11~24시)인지 확인 */
function isGameTimeKST(): boolean {
  const now = new Date();
  const kstHour = (now.getUTCHours() + 9) % 24;
  return kstHour >= 11; // 11시~자정
}

/** 경기 시간대: 1시간, 비경기: 4시간 */
function getHighlightsTTL(): number {
  return isGameTimeKST() ? 1 * 60 * 60 * 1000 : 4 * 60 * 60 * 1000;
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

function isActualShort(title: string, durationSeconds: number): boolean {
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
    return new Map<string, { durationSeconds: number; channelId: string }>();
  }

  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${videoIds.join(",")}&key=${YOUTUBE_API_KEY}`
    );
    const data = await res.json();
    const map = new Map<string, { durationSeconds: number; channelId: string }>();

    for (const item of (data.items || [])) {
      map.set(item.id, {
        durationSeconds: parseIsoDurationSeconds(item.contentDetails?.duration || ""),
        channelId: item.snippet?.channelId || "",
      });
    }

    return map;
  } catch {
    return new Map<string, { durationSeconds: number; channelId: string }>();
  }
}

async function searchYouTube(query: string, maxResults: number, excludeChannelId?: string): Promise<HighlightVideo[]> {
  if (!YOUTUBE_API_KEY) return [];
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${maxResults}&order=date&videoDuration=short&videoEmbeddable=true&key=${YOUTUBE_API_KEY}`
    );
    const data = await res.json();
    if (data.error) return [];

    const rawItems: YouTubeSearchItem[] = data.items || [];
    const detailMap = await fetchVideoDetails(rawItems.map((item) => item.id.videoId).filter(Boolean));

    return rawItems
      .filter((item) => {
        const detail = detailMap.get(item.id.videoId);
        if (!detail) return false;
        if (excludeChannelId && detail.channelId === excludeChannelId) return false;
        return isActualShort(decodeHtml(item.snippet.title), detail.durationSeconds);
      })
      .map((item: YouTubeSearchItem) => ({
        id: item.id.videoId,
        title: decodeHtml(item.snippet.title),
        thumbnail: item.snippet.thumbnails?.high?.url,
        channel: item.snippet.channelTitle,
        publishedAt: item.snippet.publishedAt,
      }));
  } catch {
    return [];
  }
}

// Supabase fallback: 팀 기반 하이라이트 (YouTube API 실패 시)
async function getSupabaseFallback(team: string): Promise<HighlightVideo[]> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return [];
  try {
    const supabase = supabaseAdmin;
    const { data } = await supabase
      .from("highlights")
      .select("video_id, title, thumbnail, channel, published_at")
      .eq("team", team)
      .order("published_at", { ascending: false })
      .limit(30);
    if (data && data.length > 0) {
      return data.map((v) => ({
        id: v.video_id, title: v.title, thumbnail: v.thumbnail,
        channel: v.channel, publishedAt: v.published_at,
      }));
    }
  } catch { /* ignore */ }
  return [];
}

export async function GET(req: NextRequest) {
  const team = req.nextUrl.searchParams.get("team") || "_ALL";
  const playersParam = req.nextUrl.searchParams.get("players") || "";
  const playerNames = playersParam ? playersParam.split(",").map(s => s.trim()).filter(Boolean).slice(0, 5) : [];

  // 캐시 키: 팀 + 선수 조합
  const cacheKey = playerNames.length > 0
    ? `${team}:${playerNames.sort().join(",")}`
    : team;

  // 1. Supabase fast-path 제거
  // cron이 저장한 RSS 데이터는 공식채널 전체 영상(롱폼 포함)이므로
  // 숏츠 섹션에 그대로 쓰면 롱폼 혼입 + 공식영상 중복 발생.
  // → mem-cache + YouTube API 경로(isActualShort + 공식채널 제외)로 통일.

  // 2. 메모리 캐시
  const cached = memCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < getHighlightsTTL()) {
    return NextResponse.json(cached.data, {
      headers: { "Cache-Control": `public, s-maxage=${isGameTimeKST() ? 1800 : 14400}, stale-while-revalidate=60` },
    });
  }

  // 3. YouTube 검색: 팀 + 선수별 병렬
  // 정식 팀명 사용 (예: "LG" → "LG 트윈스") — "LG 하이라이트"는 LG전자/농구 등 노이즈 유발
  const teamObj = TEAMS.find(t => t.shortName === team);
  const teamFullName = teamObj?.name || team;
  const officialChannelId = teamObj?.youtubeChannelId;
  const teamQuery = team === "_ALL" ? "프로야구 하이라이트" : `${teamFullName} 하이라이트`;
  const teamMaxResults = playerNames.length > 0 ? 10 : 30;

  const searches = [
    searchYouTube(teamQuery, teamMaxResults, officialChannelId).then(items =>
      items.map(v => ({ ...v, _label: team }))
    ),
    ...playerNames.map(name =>
      searchYouTube(`${name} 하이라이트`, 5, officialChannelId).then(items =>
        items.map(v => ({ ...v, _label: name }))
      )
    ),
  ];

  const results = await Promise.all(searches);
  const seen = new Set<string>();
  const merged: (HighlightVideo & { _label: string })[] = [];

  // 선수별 영상 먼저 추가 (균등 배분 보장)
  for (let i = 1; i < results.length; i++) {
    for (const v of results[i]) {
      if (!seen.has(v.id)) {
        seen.add(v.id);
        merged.push(v);
      }
    }
  }

  // 팀 영상으로 나머지 채우기
  for (const v of results[0]) {
    if (!seen.has(v.id)) {
      seen.add(v.id);
      merged.push(v);
    }
  }

  // YouTube 결과가 비어있으면 Supabase fallback (쿼터 초과 등)
  // fallback 데이터도 제목 기반 숏츠 필터링 + 선수 이름 매칭 적용
  if (merged.length === 0) {
    const fallbackItems = await getSupabaseFallback(team);
    if (fallbackItems.length > 0) {
      const filtered = fallbackItems.filter(v => {
        const t = v.title.toLowerCase();
        const title = v.title;
        
        // 1) 키워드 기반 숏츠
        const hasShortKeyword = t.includes("#shorts") || t.includes("shorts") || title.includes("숏츠") || title.includes("쇼츠");
        
        // 2) 공식 클립 패턴: [날짜 vs 팀] 시작 + H/L·직캠 제외
        const isOfficialClip = /^\[\d+\.\d+\s+vs\s+/.test(title);
        const isLongForm = title.includes("H/L") || title.includes("직캠");
        
        // 3) 최애선수 이름이 제목에 포함된 영상 (롱폼 제외)
        const matchesPlayer = playerNames.length > 0 && playerNames.some(name => title.includes(name));
        
        return hasShortKeyword || (matchesPlayer && !isLongForm) || (isOfficialClip && !isLongForm);
      });
      if (filtered.length > 0) {
        // fallback 결과는 캐시 TTL을 짧게 (10분) — YouTube API 복구 시 빠른 갱신
        const result = { items: filtered.map(v => {
          const matchedPlayer = playerNames.find(name => v.title.includes(name));
          return { ...v, label: matchedPlayer || team };
        }) };
        memCache.set(cacheKey, { data: result, ts: Date.now() - getHighlightsTTL() + 10 * 60 * 1000 });
        return NextResponse.json(result);
      }
    }
  }

  // 최신순 정렬
  merged.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  const items = merged.map(({ _label, ...rest }) => ({ ...rest, label: _label }));
  const result = { items };
  if (items.length > 0) memCache.set(cacheKey, { data: result, ts: Date.now() });
  return NextResponse.json(result, {
    headers: { "Cache-Control": `public, s-maxage=${isGameTimeKST() ? 1800 : 14400}, stale-while-revalidate=60` },
  });
}
