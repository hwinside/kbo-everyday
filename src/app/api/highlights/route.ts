import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

// 인메모리 fallback (Supabase 데이터 없을 때)
const memCache = new Map<string, { data: any; ts: number }>();
const MEM_TTL = 4 * 60 * 60 * 1000;

const TEAM_QUERIES: Record<string, string[]> = {
  LG: ["LG 트윈스 하이라이트", "LG 박해민 문보경 홍창기"],
  "두산": ["두산 베어스 하이라이트", "두산 양의지 허경민 박찬호"],
  KT: ["KT 위즈 하이라이트", "KT 강백호 소형준"],
  SSG: ["SSG 랜더스 하이라이트", "SSG 최정 추신수 김광현"],
  NC: ["NC 다이노스 하이라이트", "NC 박건우 구창모"],
  KIA: ["KIA 타이거즈 하이라이트", "KIA 김도영 나성범"],
  "삼성": ["삼성 라이온즈 하이라이트", "삼성 구자욱 김영웅"],
  "롯데": ["롯데 자이언츠 하이라이트", "롯데 전준우 한동희"],
  "한화": ["한화 이글스 하이라이트", "한화 노시환 문동주"],
  "키움": ["키움 히어로즈 하이라이트", "키움 이형종 안우진"],
};

function decodeHtml(s: string) {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

async function fetchYouTubeDirect(query: string, maxResults = 20) {
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${maxResults}&order=date&videoDuration=short&videoEmbeddable=true&key=${YOUTUBE_API_KEY}`
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return (data.items || []).map((item: any) => ({
    id: item.id.videoId,
    title: decodeHtml(item.snippet.title),
    thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
    channel: item.snippet.channelTitle,
    publishedAt: item.snippet.publishedAt,
  }));
}

export async function GET(req: NextRequest) {
  const team = req.nextUrl.searchParams.get("team");
  const q = req.nextUrl.searchParams.get("q");

  // 1. Supabase에서 읽기 (Cron이 채워둔 데이터)
  if (team && SUPABASE_URL) {
    try {
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
      const { data, error } = await supabase
        .from("highlights")
        .select("video_id, title, thumbnail, channel, published_at")
        .eq("team", team)
        .order("published_at", { ascending: false })
        .limit(30);

      if (!error && data && data.length > 0) {
        const items = data.map((v) => ({
          id: v.video_id,
          title: v.title,
          thumbnail: v.thumbnail,
          channel: v.channel,
          publishedAt: v.published_at,
        }));
        return NextResponse.json({ items });
      }
    } catch {
      // Supabase 실패 → fallback
    }
  }

  // 2. 인메모리 캐시 fallback
  const cacheKey = team || q || "KBO";
  const cached = memCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < MEM_TTL) {
    return NextResponse.json(cached.data);
  }

  // 3. YouTube API 직접 호출 (최후 수단)
  if (!YOUTUBE_API_KEY) {
    return NextResponse.json({ items: [] });
  }

  try {
    const queries = TEAM_QUERIES[team || ""] || [`${q || "KBO 프로야구 하이라이트"}`];
    const results = await Promise.all(
      queries.map((qr) => fetchYouTubeDirect(qr, 15).catch(() => []))
    );

    const seen = new Set<string>();
    const all = results.flat().filter((v) => {
      if (seen.has(v.id)) return false;
      seen.add(v.id);
      return true;
    });

    all.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
    const result = { items: all.slice(0, 30) };
    if (all.length > 0) memCache.set(cacheKey, { data: result, ts: Date.now() });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ items: [] });
  }
}
