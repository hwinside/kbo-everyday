import { NextRequest, NextResponse } from "next/server";

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

// 팀별 캐시 (서버 메모리)
const teamCache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4시간

// 팀별 고정 쿼리 (선수명 포함으로 개인 하이라이트도 검색)
const TEAM_QUERIES: Record<string, string[]> = {
  "LG": ["LG 트윈스 하이라이트", "LG 박해민 문보경 홍창기"],
  "두산": ["두산 베어스 하이라이트", "두산 양의지 허경민 박찬호"],
  "KT": ["KT 위즈 하이라이트", "KT 강백호 소형준 쿠에바스"],
  "SSG": ["SSG 랜더스 하이라이트", "SSG 최정 추신수 김광현"],
  "NC": ["NC 다이노스 하이라이트", "NC 박건우 구창모 손아섭"],
  "KIA": ["KIA 타이거즈 하이라이트", "KIA 김도영 나성범 양현종"],
  "삼성": ["삼성 라이온즈 하이라이트", "삼성 구자욱 김영웅 원태인"],
  "롯데": ["롯데 자이언츠 하이라이트", "롯데 전준우 한동희 박세웅"],
  "한화": ["한화 이글스 하이라이트", "한화 노시환 강백호 문동주"],
  "키움": ["키움 히어로즈 하이라이트", "키움 이형종 안우진 하영민"],
};

function decodeHtml(s: string) {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&#x27;/g, "'");
}

async function fetchYouTube(query: string, maxResults: number = 30): Promise<any[]> {
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

async function getTeamHighlights(team: string): Promise<any[]> {
  const cached = teamCache.get(team);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.data;
  }

  if (!YOUTUBE_API_KEY) return [];

  const queries = TEAM_QUERIES[team] || [`${team} 하이라이트`];

  try {
    // 팀당 2개 쿼리 동시 실행
    const results = await Promise.all(
      queries.map(q => fetchYouTube(q, 20).catch(() => []))
    );

    // 중복 제거 + 합치기
    const seen = new Set<string>();
    const all: any[] = [];
    for (const items of results) {
      for (const item of items) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          all.push(item);
        }
      }
    }

    // 최신순 정렬
    all.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
    const final = all.slice(0, 30);

    if (final.length > 0) {
      teamCache.set(team, { data: final, ts: Date.now() });
    }
    return final;
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  const team = req.nextUrl.searchParams.get("team");
  const q = req.nextUrl.searchParams.get("q");

  // 팀 쿼리인 경우 → 최적화된 팀 캐시 사용
  if (team && TEAM_QUERIES[team]) {
    const items = await getTeamHighlights(team);
    return NextResponse.json({ items });
  }

  // 커스텀 쿼리 (하위 호환)
  const query = q || "KBO 프로야구 하이라이트";
  const cached = teamCache.get(query);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json({ items: cached.data });
  }

  if (!YOUTUBE_API_KEY) {
    return NextResponse.json({ items: [], error: "YouTube API not configured" });
  }

  try {
    const items = await fetchYouTube(query, 30);
    if (items.length > 0) {
      teamCache.set(query, { data: items, ts: Date.now() });
    }
    return NextResponse.json({ items });
  } catch (e: any) {
    return NextResponse.json({ items: [], error: e.message });
  }
}
