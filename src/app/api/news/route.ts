import { NextRequest, NextResponse } from "next/server";

const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID || "";
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET || "";

// 1시간 캐시 (player별, team별 독립 캐시)
const cache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL = 60 * 60 * 1000;

export async function GET(req: NextRequest) {
  const team = req.nextUrl.searchParams.get("team");
  const player = req.nextUrl.searchParams.get("player");
  const q = req.nextUrl.searchParams.get("q");

  let searchQuery = "KBO 프로야구";
  if (player) {
    searchQuery = `KBO ${player}`;
  } else if (team) {
    searchQuery = `프로야구 ${team}`;
  } else if (q) {
    searchQuery = q;
  }

  const cacheKey = searchQuery;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json(cached.data);
  }

  if (!NAVER_CLIENT_ID) {
    console.error('[API/news] Missing NAVER_CLIENT_ID');
    return NextResponse.json({ items: [], error: "Naver API not configured", _q: searchQuery });
  }
  
  console.log('[API/news] Query:', searchQuery);

  try {
    const res = await fetch(
      `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(searchQuery)}&display=20&sort=date`,
      {
        headers: {
          "X-Naver-Client-Id": NAVER_CLIENT_ID,
          "X-Naver-Client-Secret": NAVER_CLIENT_SECRET,
        },
      }
    );

    const data = await res.json();

    const items = (data.items || []).map((item: any) => ({
      title: item.title
        .replace(/<[^>]+>/g, "")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#039;/g, "'")
        .replace(/&apos;/g, "'"),
      description: item.description
        .replace(/<[^>]+>/g, "")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#039;/g, "'")
        .replace(/&apos;/g, "'"),
      link: item.originallink || item.link,
      pubDate: item.pubDate,
    }));

    const result = { items, _q: cacheKey };
    cache.set(cacheKey, { data: result, ts: Date.now() });
    return NextResponse.json(result);
  } catch (e: any) {
    console.error('[API/news] Fetch error:', e.message);
    return NextResponse.json({ items: [], error: e.message, _q: searchQuery });
  }
}
