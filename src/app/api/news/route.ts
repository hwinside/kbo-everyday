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
const THUMBNAIL_FETCH_LIMIT = 12;
const THUMBNAIL_CONCURRENCY = 4;
const THUMBNAIL_TIMEOUT_MS = 2500;

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

function isSafeHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") return false;
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
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
    (item) => fetchThumbnailUrl(item.link),
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
      title: cleanHtml(item.title),
      description: cleanHtml(item.description),
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

    const itemsWithThumbnails = await attachThumbnails(unique);
    const result = { items: itemsWithThumbnails, _q: cacheKey };
    cache.set(cacheKey, { data: result, ts: Date.now() });
    return NextResponse.json(result);
  } catch (e: unknown) {
    console.error('[API/news] Fetch error:', (e as Error).message);
    return NextResponse.json({ items: [], error: (e as Error).message, _q: searchQuery });
  }
}
