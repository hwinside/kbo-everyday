// 네이버 뉴스 검색 + OG 썸네일 공용 헬퍼 — /api/news(팀 뉴스탭·홈 히어로)와
// 뉴스클리핑 cron(/api/cron/news-clipping)이 공유하는 SSOT.
// news-relevance.ts와 같은 이유로 분리 — 두 소비자가 각자 복제하면 drift가 난다.

import type { NaverNewsRawItem, NewsItem } from "@/types/api";
import { isNaverNewsUrl } from "@/lib/news-relevance";

const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID || "";
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET || "";

export const NEWS_DISPLAY_LIMIT = 20;
const THUMBNAIL_TIMEOUT_MS = 2500;

/** shortName → 검색에 유리한 풀네임 매핑 */
export const TEAM_SEARCH: Record<string, string> = {
  "LG": "LG 트윈스", "두산": "두산 베어스", "KT": "KT 위즈",
  "SSG": "SSG 랜더스", "NC": "NC 다이노스", "KIA": "KIA 타이거즈",
  "롯데": "롯데 자이언츠", "삼성": "삼성 라이온즈", "한화": "한화 이글스",
  "키움": "키움 히어로즈",
};

export function isNaverNewsConfigured(): boolean {
  return Boolean(NAVER_CLIENT_ID);
}

export function cleanHtml(str: string): string {
  return str
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'");
}

export async function fetchNaverNews(searchQuery: string, start = 1, display = NEWS_DISPLAY_LIMIT): Promise<NewsItem[]> {
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
  return (data.items || [])
    .map((item: NaverNewsRawItem) => ({
      title: cleanHtml(item.title),
      description: cleanHtml(item.description),
      // 네이버 뉴스 URL(link) 우선 — 미등록 기사만 언론사 원문(originallink)으로 폴백
      link: item.link || item.originallink,
      // 출처 표기용 언론사 원문 URL 보존 (클릭은 link, 출처는 originalLink)
      originalLink: item.originallink || item.link,
      pubDate: item.pubDate,
    }))
    // '무조건 네이버' 보장 — link가 네이버 뉴스 URL이 아닌(미등록) 기사는 노출 제외
    .filter((item: NewsItem) => isNaverNewsUrl(item.link));
}

export function isSafeHttpUrl(url: string): boolean {
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

export async function fetchThumbnailUrl(articleUrl: string): Promise<string | null> {
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

export async function mapWithConcurrency<T, R>(
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
