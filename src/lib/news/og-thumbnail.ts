import type { NewsItem } from "@/types/api";

// 기사 원문 og:image 추출 + URL 단위 캐시. /api/news(팀 뉴스탭)와
// /api/news/batch(홈 뉴스)가 공유하는 SSOT. 둘 다 같은 추출 로직/캐시를
// 쓰게 해서 드리프트(한쪽만 고쳐 동작 갈림)를 막는다.
//
// 캐시 분리 원칙: 뉴스 응답 캐시(1h)는 _썸네일 없는 raw items_만 저장하고,
// 썸네일은 요청마다 attachThumbnails로 다시 합치되 여기 URL 단위 TTL이
// 적용되게 한다 — og 일시 실패가 1h 응답 캐시에 굳지 않도록.

const THUMBNAIL_FETCH_LIMIT = 20; // 응답 카드 수와 맞춰 스크롤 후 빈 카드 방지
const THUMBNAIL_CONCURRENCY = 4;
const THUMBNAIL_TIMEOUT_MS = 2500;
const THUMBNAIL_CACHE_MAX = 500;
const THUMBNAIL_SUCCESS_TTL = 24 * 60 * 60 * 1000;
const THUMBNAIL_FAILURE_TTL = 10 * 60 * 1000;

// 기사 URL 단위 og:image 캐시. 성공은 24h, 실패는 10분만 보관.
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

/**
 * 뉴스 items의 link에서 og:image를 추출해 thumbnailUrl로 머지.
 * URL 단위 캐시(성공 24h / 실패 10분)로 og 일시 실패가 응답 캐시에 굳지 않게 한다.
 * 추출 실패 시 thumbnailUrl=null (호출측은 null이면 썸네일 없이 현행 렌더).
 */
export async function attachThumbnails<T extends NewsItem>(items: T[]): Promise<T[]> {
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
