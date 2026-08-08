// 네이버 뉴스 검색 + OG 썸네일 공용 헬퍼 — /api/news(팀 뉴스탭·홈 히어로)와
// 뉴스클리핑 cron(/api/cron/news-clipping)이 공유하는 SSOT.
// news-relevance.ts와 같은 이유로 분리 — 두 소비자가 각자 복제하면 drift가 난다.

import type { NaverNewsRawItem, NewsItem } from "@/types/api";
import { isNaverNewsUrl } from "@/lib/news-relevance";

const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID || "";
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET || "";

export const NEWS_DISPLAY_LIMIT = 20;
const THUMBNAIL_TIMEOUT_MS = 2500;
/** 네이버 검색 호출 상한. 무한 대기는 cron maxDuration 을 통째로 먹는다. */
const NAVER_SEARCH_TIMEOUT_MS = 8000;

/**
 * 호출 간 최소 간격(ms). **모든** 네이버 검색 호출을 직렬화해 간격을 강제한다.
 *
 * 왜 호출측이 아니라 여기인가 (2026-08-07 실측)
 *   14일 백필을 팀 동시성 3으로 돌렸더니 첫 팀에서 바로 **HTTP 429** 가 떨어졌다.
 *   일 한도(25,000)가 아니라 초당 제한이다 — 총 호출은 99회에 불과했다.
 *   호출측마다 간격을 지키게 하면 한 곳만 빼먹어도 전체가 429 로 부분 실패하므로,
 *   네이버 호출의 SSOT 인 여기서 강제한다. 동시성 1 + 150ms 로 10팀 14일이 28초에 완주됐다.
 */
export const NAVER_MIN_INTERVAL_MS = 150;

/** 429 재시도 횟수. 초당 제한은 일시적이라 짧게 기다리면 풀린다. */
const NAVER_RATE_LIMIT_RETRIES = 3;

/**
 * 호출 직렬화 게이트. 호출측이 몇 개든 동시에 불러도 이 체인을 통과하며 간격이 보장된다.
 * 테스트가 실측할 수 있게 마지막 호출 시각을 노출한다.
 */
let naverGate: Promise<void> = Promise.resolve();
let lastNaverCallAt = 0;

async function acquireNaverSlot(): Promise<void> {
  const previous = naverGate;
  let release!: () => void;
  naverGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  const wait = lastNaverCallAt + NAVER_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNaverCallAt = Date.now();
  // 잠금은 직후 푸는다 — 간격만 보장하면 되고 응답까지 직렬화할 필요는 없다.
  release();
}

/**
 * 네이버 검색 실패. 빈 배열과 반드시 구분돼야 한다.
 *
 * 왜 throw 하는가
 *   네이버는 429/500 에도 JSON 본문을 준다. `res.ok` 를 안 보면 그 본문에 items 가 없어
 *   조용히 `[]` 가 되고, 호출측은 그것을 **"그날 기사가 없다"** 로 읽는다. 그러면 근거 적재
 *   커버리지에 `status=ok, collected=0` 으로 남아 사후에 장애를 발견할 수 없다.
 *   실패는 실패로 드러나야 한다.
 */
export class NaverNewsError extends Error {
  constructor(
    message: string,
    readonly reason: "http" | "timeout" | "malformed",
    readonly status?: number,
  ) {
    super(message);
    this.name = "NaverNewsError";
  }
}

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

/**
 * 한 페이지 응답. `rawCount` 는 **필터 전 원응답 개수**다.
 *
 * 왜 필요한가 (삼순 NO-GO)
 *   fetchNaverNews 는 비네이버 기사를 걸러 내보내므로, 호출측이 `items.length < 100` 으로
 *   "이 쿼리는 고갈됐다" 를 판정하면 100건 중 1건만 탈락해도 조기 종료한다. 백필에서는
 *   그 한 건 때문에 과거 수백 건을 통째로 못 본다. 종료 판정은 원응답 개수로 해야 한다.
 */
export interface NaverNewsPage {
  items: NewsItem[];
  rawCount: number;
}

export async function fetchNaverNewsPage(
  searchQuery: string,
  start = 1,
  display = NEWS_DISPLAY_LIMIT,
): Promise<NaverNewsPage> {
  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(searchQuery)}&display=${display}&start=${start}&sort=date`;

  let res!: Response;
  for (let attempt = 0; ; attempt++) {
    // 모든 호출은 게이트를 거친다 — 호출측 동시성과 무관하게 간격이 보장된다.
    await acquireNaverSlot();
    try {
      res = await fetch(url, {
        headers: {
          "X-Naver-Client-Id": NAVER_CLIENT_ID,
          "X-Naver-Client-Secret": NAVER_CLIENT_SECRET,
        },
        signal: AbortSignal.timeout(NAVER_SEARCH_TIMEOUT_MS),
      });
    } catch (e) {
      throw new NaverNewsError(`naver search request failed: ${(e as Error).message}`, "timeout");
    }

    // 429 = 초당 제한. 일시적이므로 짧게 물러섬다가 다시 묻는다.
    // 그래도 안 되면 반드시 throw 한다 — 조용한 부분 수집이 가장 나쁜 결과다.
    if (res.status === 429 && attempt < NAVER_RATE_LIMIT_RETRIES) {
      await new Promise((r) => setTimeout(r, NAVER_MIN_INTERVAL_MS * 4 * (attempt + 1)));
      continue;
    }
    break;
  }

  // 429/500 도 JSON 을 준다. 여기서 안 막으면 실패가 빈 결과로 위장된다.
  if (!res.ok) {
    throw new NaverNewsError(`naver search http ${res.status}`, "http", res.status);
  }

  let data: { items?: unknown };
  try {
    data = (await res.json()) as { items?: unknown };
  } catch (e) {
    throw new NaverNewsError(`naver search malformed body: ${(e as Error).message}`, "malformed");
  }
  // items 자체가 없으면 응답 스키마가 깨진 것이다. **빈 성공으로 받지 않는다** —
  // 상태 200 에 `{}` 를 주는 게이트웨이·프록시 응답이 실재하고, 그걸 0건으로 읽으면
  // 커버리지에 `ok/0건` 으로 남아 장애가 영영 안 보인다(삼순 NO-GO).
  if (!Array.isArray(data.items)) {
    throw new NaverNewsError("naver search malformed items", "malformed");
  }

  const raw = data.items as NaverNewsRawItem[];
  const items = raw
    .map((item: NaverNewsRawItem): NewsItem => ({
      title: cleanHtml(item.title),
      description: cleanHtml(item.description),
      // 네이버 뉴스 URL(link) 우선 — 미등록 기사만 언론사 원문(originallink)으로 폴백
      link: item.link || item.originallink || "",
      // 출처 표기용 언론사 원문 URL 보존 (클릭은 link, 출처는 originalLink)
      originalLink: item.originallink || item.link,
      pubDate: item.pubDate,
    }))
    // '무조건 네이버' 보장 — link가 네이버 뉴스 URL이 아닌(미등록) 기사는 노출 제외
    .filter((item: NewsItem) => isNaverNewsUrl(item.link));

  return { items, rawCount: raw.length };
}

/** 기존 소비자용 얇은 래퍼 — 필터된 기사만 필요할 때. */
export async function fetchNaverNews(
  searchQuery: string,
  start = 1,
  display = NEWS_DISPLAY_LIMIT,
): Promise<NewsItem[]> {
  return (await fetchNaverNewsPage(searchQuery, start, display)).items;
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
