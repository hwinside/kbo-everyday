import { NextRequest, NextResponse } from "next/server";
import type { NaverNewsRawItem, NewsItem } from "@/types/api";
import { isTeamBaseballRelevant } from "@/lib/news-relevance";
import { attachThumbnails } from "@/lib/news/og-thumbnail";

const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID || "";
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET || "";

// 1시간 캐시는 _썸네일 없는 raw items_만 저장한다. 썸네일은 요청마다
// attachThumbnails로 다시 합치되 URL 단위 thumbnailCache TTL이 적용되게 해서
// og 일시 실패가 1h 응답 캐시에 굳지 않도록 분리.
interface NewsResult {
  items: NewsItem[];
  _q: string;
}

const cache = new Map<string, { data: NewsResult; ts: number }>();
const CACHE_TTL = 60 * 60 * 1000;
const NEWS_DISPLAY_LIMIT = 20;
const PLAYER_NEWS_DISPLAY_LIMIT = 100;
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

function normalizeForMatch(str: string): string {
  return str.toLowerCase().replace(/\s+/g, "");
}

function buildTeamTokens(team: string | null, teamSearch: Record<string, string>): string[] {
  if (!team) return [];
  const fullName = teamSearch[team] || team;
  return Array.from(new Set([team, ...fullName.split(/\s+/)].filter(Boolean)));
}

function isPlayerRelevantNews(item: NewsItem, playerName: string, teamTokens: string[]): boolean {
  const normalizedTitle = normalizeForMatch(item.title);
  const normalizedBody = normalizeForMatch(`${item.title} ${item.description}`);
  const normalizedPlayer = normalizeForMatch(playerName);
  if (!normalizedTitle.includes(normalizedPlayer)) return false;
  if (teamTokens.length === 0) return true;

  return teamTokens.some((token) => normalizedBody.includes(normalizeForMatch(token)));
}

async function fetchNaverNews(searchQuery: string, start = 1, display = NEWS_DISPLAY_LIMIT): Promise<NewsItem[]> {
  const res = await fetch(
    `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(searchQuery)}&display=${display}&start=${start}&sort=date`,
    {
      headers: {
        "X-Naver-Client-Id": NAVER_CLIENT_ID,
        "X-Naver-Client-Secret": NAVER_CLIENT_SECRET,
      },
    }
  );

  const data = await res.json();
  return (data.items || []).map((item: NaverNewsRawItem) => ({
    title: cleanHtml(item.title),
    description: cleanHtml(item.description),
    link: item.originallink || item.link,
    pubDate: item.pubDate,
  }));
}

export async function GET(req: NextRequest) {
  const team = req.nextUrl.searchParams.get("team");
  const player = req.nextUrl.searchParams.get("player");
  const q = req.nextUrl.searchParams.get("q");
  const includeThumbnail = req.nextUrl.searchParams.get("includeThumbnail") === "1";

  // shortName → 검색에 유리한 풀네임 매핑
  const TEAM_SEARCH: Record<string, string> = {
    "LG": "LG 트윈스", "두산": "두산 베어스", "KT": "KT 위즈",
    "SSG": "SSG 랜더스", "NC": "NC 다이노스", "KIA": "KIA 타이거즈",
    "롯데": "롯데 자이언츠", "삼성": "삼성 라이온즈", "한화": "한화 이글스",
    "키움": "키움 히어로즈",
  };

  let searchQuery = "KBO 프로야구";
  if (player) {
    searchQuery = team ? `${team} ${player}` : `KBO ${player}`;
  } else if (team) {
    searchQuery = `프로야구 ${TEAM_SEARCH[team] || team}`;
  } else if (q) {
    searchQuery = q;
  }

  // 썸네일 부착은 팀 뉴스탭(team) 또는 명시적 includeThumbnail=1에만 적용.
  // 선수 뉴스는 player+team으로 호출해 제목 선수명 + 본문/제목 팀명 relevance 필터 후 썸네일을 붙인다.
  const wantThumbnails = Boolean(team) || includeThumbnail;

  const cacheKey = player ? `player:${team || ""}:${searchQuery}` : searchQuery;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    const items = wantThumbnails ? await attachThumbnails(cached.data.items) : cached.data.items;
    return NextResponse.json({ items, _q: cached.data._q });
  }

  if (!NAVER_CLIENT_ID) {
    console.error('[API/news] Missing NAVER_CLIENT_ID');
    return NextResponse.json({ items: [], error: "Naver API not configured", _q: searchQuery });
  }

  try {
    const seen = new Set<string>();
    let unique: NewsItem[] = [];

    if (player) {
      const teamTokens = buildTeamTokens(team, TEAM_SEARCH);
      const items = await fetchNaverNews(searchQuery, 1, PLAYER_NEWS_DISPLAY_LIMIT);
      unique = items.filter((item: NewsItem) => {
        if (seen.has(item.link)) return false;
        seen.add(item.link);
        return isPlayerRelevantNews(item, player, teamTokens);
      }).slice(0, NEWS_DISPLAY_LIMIT);
    } else {
      // 팀 뉴스는 마스코트 게이트 적용, q/기본(KBO 전체) 검색은 그대로 통과.
      const teamMascot = team ? TEAM_SEARCH[team]?.split(/\s+/).pop() || null : null;
      const items = await fetchNaverNews(searchQuery, 1, NEWS_DISPLAY_LIMIT);
      unique = items.filter((item: NewsItem) => {
        if (seen.has(item.link)) return false;
        seen.add(item.link);
        return team
          ? isTeamBaseballRelevant(item.title, item.description, teamMascot)
          : true;
      });
    }

    // 캐시는 _썸네일 없는 raw items_만 저장.
    cache.set(cacheKey, { data: { items: unique, _q: searchQuery }, ts: Date.now() });

    let itemsOut = wantThumbnails ? await attachThumbnails(unique) : unique;
    if (player) {
      const withThumbnail = itemsOut.filter((item) => item.thumbnailUrl);
      const withoutThumbnail = itemsOut.filter((item) => !item.thumbnailUrl);
      itemsOut = [...withThumbnail, ...withoutThumbnail].slice(0, 5);
    }
    return NextResponse.json({ items: itemsOut, _q: searchQuery });
  } catch (e: unknown) {
    console.error('[API/news] Fetch error:', (e as Error).message);
    return NextResponse.json({ items: [], error: (e as Error).message, _q: searchQuery });
  }
}
