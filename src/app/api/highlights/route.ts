import { NextRequest, NextResponse } from "next/server";

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

// 글로벌 캐시: 쿼리별 결과 + 마스터 캐시 (팀별)
const cache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL = 2 * 60 * 60 * 1000; // 2시간 (30분→2시간)
const MASTER_CACHE_TTL = 6 * 60 * 60 * 1000; // 마스터 캐시 6시간

// 팀별 사전 정의 쿼리 (API 호출 최소화)
const TEAM_QUERIES: Record<string, string> = {
  "LG": "LG 트윈스 하이라이트",
  "두산": "두산 베어스 하이라이트",
  "KT": "KT 위즈 하이라이트",
  "SSG": "SSG 랜더스 하이라이트",
  "NC": "NC 다이노스 하이라이트",
  "KIA": "KIA 타이거즈 하이라이트",
  "롯데": "롯데 자이언츠 하이라이트",
  "삼성": "삼성 라이온즈 하이라이트",
  "한화": "한화 이글스 하이라이트",
  "키움": "키움 히어로즈 하이라이트",
};

// 마스터 캐시 키
const MASTER_KEY = "__KBO_MASTER__";

function decodeHtml(s: string) {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&#x27;/g, "'");
}

async function fetchYouTube(query: string, maxResults: number = 20) {
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

  // 선수별 개별 쿼리 → 팀 쿼리로 통합 (API 절약)
  // 개별 선수 쿼리는 마스터 캐시에서 필터링
  const query = q || TEAM_QUERIES[team || ""] || "KBO 프로야구 하이라이트";

  // 1. 쿼리별 캐시 확인 (2시간)
  const cached = cache.get(query);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json(cached.data);
  }

  // 2. 마스터 캐시 확인 (6시간) — 같은 팀이면 마스터에서
  if (team && TEAM_QUERIES[team]) {
    const masterCached = cache.get(TEAM_QUERIES[team]);
    if (masterCached && Date.now() - masterCached.ts < MASTER_CACHE_TTL) {
      return NextResponse.json(masterCached.data);
    }
  }

  if (!YOUTUBE_API_KEY) {
    return NextResponse.json({ items: [], error: "YouTube API not configured" });
  }

  try {
    const items = await fetchYouTube(query, 30);
    const result = { items };
    if (items.length > 0) {
      cache.set(query, { data: result, ts: Date.now() });
    }
    return NextResponse.json(result);
  } catch (e: any) {
    // 할당량 초과 시 빈 배열 (에러 캐시 안 함)
    return NextResponse.json({ items: [], error: e.message });
  }
}
