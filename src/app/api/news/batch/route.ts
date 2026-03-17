import { NextRequest, NextResponse } from "next/server";
import type { NaverNewsRawItem, NewsItem } from "@/types/api";

const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID || "";
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET || "";

// 서버 메모리 캐시 (1시간)
const cache = new Map<string, { data: NewsItem[]; ts: number }>();
const CACHE_TTL = 60 * 60 * 1000;

function cleanHtml(str: string): string {
  return str
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'");
}

async function fetchNews(query: string): Promise<NewsItem[]> {
  const cached = cache.get(query);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.data;
  }

  try {
    const res = await fetch(
      `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query)}&display=10&sort=date`,
      {
        headers: {
          "X-Naver-Client-Id": NAVER_CLIENT_ID,
          "X-Naver-Client-Secret": NAVER_CLIENT_SECRET,
        },
      }
    );
    const data = await res.json();
    const items: NewsItem[] = (data.items || []).map((item: NaverNewsRawItem) => ({
      title: cleanHtml(item.title),
      description: cleanHtml(item.description),
      link: item.originallink || item.link,
      pubDate: item.pubDate,
    }));
    cache.set(query, { data: items, ts: Date.now() });
    return items;
  } catch {
    return [];
  }
}

/**
 * POST /api/news/batch
 * Body: { team: string, players: { name: string, teamName: string }[] }
 * Returns: { items: Array<NewsItem & { _label: string }> }
 */
export async function POST(req: NextRequest) {
  if (!NAVER_CLIENT_ID) {
    return NextResponse.json({ items: [] });
  }

  try {
    const body = await req.json();
    const team: string = body.team || "";
    const players: { name: string; teamName: string }[] = body.players || [];

    // 모든 쿼리를 병렬로 실행
    const queries: { query: string; label: string }[] = [];

    if (team) {
      queries.push({ query: `프로야구 ${team}`, label: team });
    }

    for (const p of players.slice(0, 5)) {
      queries.push({
        query: `${p.teamName} ${p.name}`,
        label: p.name,
      });
    }

    const results = await Promise.all(
      queries.map(async (q) => {
        const items = await fetchNews(q.query);
        return items.map((item) => ({ ...item, _label: q.label }));
      })
    );

    // 중복 제거 + 선수별 균등 분배
    const seen = new Set<string>();
    const dedup = (items: (NewsItem & { _label: string })[]) =>
      items.filter((item) => {
        if (seen.has(item.link)) return false;
        seen.add(item.link);
        return true;
      });

    // 팀 뉴스는 첫 번째, 나머지는 선수별
    const teamItems = results[0] && team ? dedup(results[0]).slice(0, 5) : [];
    const playerItems = results
      .slice(team ? 1 : 0)
      .flatMap((items) => dedup(items).slice(0, 3));

    const allItems = [...playerItems, ...teamItems];
    allItems.sort(
      (a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime()
    );

    return NextResponse.json({ items: allItems.slice(0, 10) });
  } catch {
    return NextResponse.json({ items: [] });
  }
}
