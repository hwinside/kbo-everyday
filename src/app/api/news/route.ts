import { NextRequest, NextResponse } from "next/server";
import type { NaverNewsRawItem, NewsItem } from "@/types/api";

const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID || "";
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET || "";

// 1시간 캐시 (player별, team별 독립 캐시)
interface NewsResult {
  items: NewsItem[];
  _q: string;
}

const cache = new Map<string, { data: NewsResult; ts: number }>();
const CACHE_TTL = 60 * 60 * 1000;

export async function GET(req: NextRequest) {
  const team = req.nextUrl.searchParams.get("team");
  const player = req.nextUrl.searchParams.get("player");
  const q = req.nextUrl.searchParams.get("q");

  // shortName → 검색에 유리한 풀네임 매핑
  const TEAM_SEARCH: Record<string, string> = {
    "LG": "LG 트윈스", "두산": "두산 베어스", "KT": "KT 위즈",
    "SSG": "SSG 랜더스", "NC": "NC 다이노스", "KIA": "KIA 타이거즈",
    "롯데": "롯데 자이언츠", "삼성": "삼성 라이온즈", "한화": "한화 이글스",
    "키움": "키움 히어로즈",
  };

  let searchQuery = "KBO 프로야구";
  if (player) {
    searchQuery = `KBO ${player}`;
  } else if (team) {
    searchQuery = `프로야구 ${TEAM_SEARCH[team] || team}`;
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

    const items: NewsItem[] = (data.items || []).map((item: NaverNewsRawItem) => ({
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

    // 중복 기사 제거 (link 기준)
    const seen = new Set<string>();
    const unique = items.filter((item: NewsItem) => {
      if (seen.has(item.link)) return false;
      seen.add(item.link);
      return true;
    });

    const result = { items: unique, _q: cacheKey };
    cache.set(cacheKey, { data: result, ts: Date.now() });
    return NextResponse.json(result);
  } catch (e: unknown) {
    console.error('[API/news] Fetch error:', (e as Error).message);
    return NextResponse.json({ items: [], error: (e as Error).message, _q: searchQuery });
  }
}
