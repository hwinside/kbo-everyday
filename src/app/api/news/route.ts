import { NextRequest, NextResponse } from "next/server";
import type { NaverNewsRawItem, NewsItem } from "@/types/api";
import { isTeamBaseballRelevant } from "@/lib/news-relevance";

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
const THUMBNAIL_FETCH_LIMIT = NEWS_DISPLAY_LIMIT; // Naver display=20과 일치 — 모든 응답 카드에 og fetch 시도해서 스크롤 후 빈 카드 방지
const THUMBNAIL_CONCURRENCY = 4;
const THUMBNAIL_TIMEOUT_MS = 2500;
const THUMBNAIL_CACHE_MAX = 500;
const THUMBNAIL_SUCCESS_TTL = 24 * 60 * 60 * 1000;
const THUMBNAIL_FAILURE_TTL = 10 * 60 * 1000;

// 기사 URL 단위 og:image 캐시. 성공은 24h, 실패는 10분만 보관해서
// 일시적 장애가 1h 뉴스 응답 캐시에 굳지 않도록 분리.
const thumbnailCache = new Map<string, { url: string | null; ts: number }>();

function getCachedThumbnail(articleUrl: string): string | null | undefined {
  const entry = thumbnailCache.get(articleUrl);
  if (!entry) return undefined;
  const ttl = entry.url ? THUMBNAIL_SUCCESS_TTL : THUMBNAIL_FAILURE_TTL;
  if (Date.now() - entry.ts > ttl) {
    thumbnailCache.delete(articleUrl);
    return undefined;
  }
  // LRU touch
  thumbnailCache.delete(articleUrl);
  thumbnailCache.set(articleUrl, entry);
  return entry.url;
}

function setCachedThumbnail(articleUrl: string, url: string | null): void {
  if (thumbnailCache.size >= THUMBNAIL_CACHE_MAX) {
    const oldest = thumbnailCache.keys().next().value;
    if (oldest) thumbnailCache.delete(oldest);
  }
  thumbnailCache.set(articleUrl, { url, ts: Date.now() });
}

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
    // 네이버 뉴스 URL(link) 우선 — 미등록 기사만 언론사 원문(originallink)으로 폴백
    link: item.link || item.originallink,
    // 출처 표기용 언론사 원문 URL 보존 (클릭은 link, 출처는 originalLink)
    originalLink: item.originallink || item.link,
    pubDate: item.pubDate,
  }));
}

function isSafeHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    let host = parsed.hostname.toLowerCase();
    // WHATWG URL.hostname returns IPv6 with brackets; strip for matching.
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") return false;
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return false; // IPv6 ULA fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(host)) return false; // IPv6 link-local fe80::/10
    return true;
  } catch {
    return false;
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&apos;/g, "'");
}

function extractMetaImage(html: string, baseUrl: string): string | null {
  const candidates = ["og:image", "twitter:image", "twitter:image:src", "image"];

  for (const key of candidates) {
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']+)["']`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${key}["']`, "i"),
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (!match?.[1]) continue;
      try {
        const imageUrl = new URL(decodeHtmlEntities(match[1].trim()), baseUrl).href;
        return isSafeHttpUrl(imageUrl) ? imageUrl : null;
      } catch {
        // Try next candidate
      }
    }
  }

  const imageSrc = html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i)
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']image_src["']/i);
  if (imageSrc?.[1]) {
    try {
      const imageUrl = new URL(decodeHtmlEntities(imageSrc[1].trim()), baseUrl).href;
      return isSafeHttpUrl(imageUrl) ? imageUrl : null;
    } catch {
      return null;
    }
  }

  return null;
}

async function fetchThumbnailUrl(articleUrl: string): Promise<string | null> {
  if (!isSafeHttpUrl(articleUrl)) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), THUMBNAIL_TIMEOUT_MS);

  try {
    const res = await fetch(articleUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; KeuboFanBot/1.0)",
        Accept: "text/html",
      },
    });

    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) return null;

    const html = (await res.text()).slice(0, 300_000);
    return extractMetaImage(html, res.url || articleUrl);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex++;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    }),
  );

  return results;
}

async function attachThumbnails(items: NewsItem[]): Promise<NewsItem[]> {
  const targetItems = items.slice(0, THUMBNAIL_FETCH_LIMIT);
  const thumbnails = await mapWithConcurrency(
    targetItems,
    THUMBNAIL_CONCURRENCY,
    async (item) => {
      const cached = getCachedThumbnail(item.link);
      if (cached !== undefined) return cached;
      const url = await fetchThumbnailUrl(item.link);
      setCachedThumbnail(item.link, url);
      return url;
    },
  );

  return items.map((item, index) => ({
    ...item,
    thumbnailUrl: index < thumbnails.length ? thumbnails[index] : null,
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
      }).slice(0, THUMBNAIL_FETCH_LIMIT);
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
