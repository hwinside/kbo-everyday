import { NextRequest, NextResponse } from "next/server";

const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID || "";
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET || "";

// 5분 캐시
let cache: { data: any; ts: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("q") || "KBO 프로야구";
  const team = req.nextUrl.searchParams.get("team");
  const searchQuery = team ? `KBO ${team}` : query;

  const cacheKey = searchQuery;
  if (cache && cache.data._q === cacheKey && Date.now() - cache.ts < CACHE_TTL) {
    return NextResponse.json(cache.data);
  }

  if (!NAVER_CLIENT_ID) {
    return NextResponse.json({ items: [], error: "Naver API not configured" });
  }

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
      title: item.title.replace(/<[^>]+>/g, ""),
      description: item.description.replace(/<[^>]+>/g, ""),
      link: item.originallink || item.link,
      pubDate: item.pubDate,
    }));

    const result = { items, _q: cacheKey };
    cache = { data: result, ts: Date.now() };
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ items: [], error: e.message });
  }
}
