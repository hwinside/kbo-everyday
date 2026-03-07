import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { TEAMS } from "@/lib/constants/teams";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

const memCache = new Map<string, { data: any; ts: number }>();
const MEM_TTL = 4 * 60 * 60 * 1000;

function decodeHtml(s: string) {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

async function searchYouTube(query: string, maxResults: number): Promise<any[]> {
  if (!YOUTUBE_API_KEY) return [];
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${maxResults}&order=date&videoDuration=short&videoEmbeddable=true&key=${YOUTUBE_API_KEY}`
    );
    const data = await res.json();
    if (data.error) return [];
    return (data.items || []).map((item: any) => ({
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
async function getSupabaseFallback(team: string): Promise<any[]> {
  if (!SUPABASE_URL) return [];
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
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

  // 1. Supabase (Cron이 채운 데이터) — 선수 검색 없는 경우만
  if (SUPABASE_URL && playerNames.length === 0) {
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
  const cached = memCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < MEM_TTL) {
    return NextResponse.json(cached.data);
  }

  // 3. YouTube 검색: 팀 + 선수별 병렬
  // 정식 팀명 사용 (예: "LG" → "LG 트윈스") — "LG 하이라이트"는 LG전자/농구 등 노이즈 유발
  const teamObj = TEAMS.find(t => t.shortName === team);
  const teamFullName = teamObj?.name || team;
  const teamQuery = team === "_ALL" ? "프로야구 하이라이트" : `${teamFullName} 하이라이트`;
  const teamMaxResults = playerNames.length > 0 ? 10 : 30;

  const searches = [
    searchYouTube(teamQuery, teamMaxResults).then(items =>
      items.map(v => ({ ...v, _label: team }))
    ),
    ...playerNames.map(name =>
      searchYouTube(`${name} 하이라이트`, 5).then(items =>
        items.map(v => ({ ...v, _label: name }))
      )
    ),
  ];

  const results = await Promise.all(searches);
  const seen = new Set<string>();
  const merged: any[] = [];

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
  if (merged.length === 0) {
    const fallbackItems = await getSupabaseFallback(team);
    if (fallbackItems.length > 0) {
      const result = { items: fallbackItems };
      return NextResponse.json(result);
    }
  }

  // 최신순 정렬
  merged.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  const items = merged.map(({ _label, ...rest }) => ({ ...rest, label: _label }));
  const result = { items };
  if (items.length > 0) memCache.set(cacheKey, { data: result, ts: Date.now() });
  return NextResponse.json(result);
}
