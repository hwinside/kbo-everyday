import { NextRequest, NextResponse } from "next/server";
import type { NewsItem } from "@/types/api";
import { newsContentId } from "@/lib/content-views/policy";
import { signContentView } from "@/lib/content-views/sign";
import { isTeamBaseballRelevant, dedupeNewsByTitle } from "@/lib/news-relevance";
import {
  TEAM_SEARCH,
  NEWS_DISPLAY_LIMIT,
  fetchNaverNews,
  fetchThumbnailUrl,
  mapWithConcurrency,
  isNaverNewsConfigured,
} from "@/lib/naver-news";

// 네이버 검색/OG 추출 로직은 src/lib/naver-news.ts로 SSOT 분리
// (뉴스클리핑 cron과 공유). 이 라우트는 캐시 + relevance 필터 + 응답만 담당.

// 1시간 캐시는 _썸네일 없는 raw items_만 저장한다. 썸네일은 요청마다
// attachThumbnails로 다시 합치되 URL 단위 thumbnailCache TTL이 적용되게 해서
// og 일시 실패가 1h 응답 캐시에 굳지 않도록 분리.
interface NewsResult {
  items: NewsItem[];
  _q: string;
}

const cache = new Map<string, { data: NewsResult; ts: number }>();
const CACHE_TTL = 60 * 60 * 1000;
const PLAYER_NEWS_DISPLAY_LIMIT = 100;
const THUMBNAIL_FETCH_LIMIT = NEWS_DISPLAY_LIMIT; // Naver display=20과 일치 — 모든 응답 카드에 og fetch 시도해서 스크롤 후 빈 카드 방지
const THUMBNAIL_CONCURRENCY = 4;
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

async function attachThumbnails(items: NewsItem[]): Promise<NewsItem[]> {
  const targetItems = items.slice(0, THUMBNAIL_FETCH_LIMIT);
  const thumbnails = await mapWithConcurrency(
    targetItems,
    THUMBNAIL_CONCURRENCY,
    async (item) => {
      // 썸네일/OG는 언론사 원문(originalLink) 기준 — 클릭(link)은 네이버, OG 품질은 원문 유지
      const ogTarget = item.originalLink || item.link;
      const cached = getCachedThumbnail(ogTarget);
      if (cached !== undefined) return cached;
      const url = await fetchThumbnailUrl(ogTarget);
      setCachedThumbnail(ogTarget, url);
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

  if (!isNaverNewsConfigured()) {
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

    // 매체만 다른 같은 사건 기사(near-duplicate) 제거 — Naver 결과가 date desc라 최신 항목 유지
    unique = dedupeNewsByTitle(unique);

    // 캐시는 _썸네일 없는 raw items_만 저장.
    cache.set(cacheKey, { data: { items: unique, _q: searchQuery }, ts: Date.now() });

    let itemsOut = wantThumbnails ? await attachThumbnails(unique) : unique;
    if (player) {
      const withThumbnail = itemsOut.filter((item) => item.thumbnailUrl);
      const withoutThumbnail = itemsOut.filter((item) => !item.thumbnailUrl);
      itemsOut = [...withThumbnail, ...withoutThumbnail].slice(0, 5);
    }
    // 조회수 서명 발급 — 서버가 실제 목록에 내보낸 기사만 /api/content-views/view 증가 가능(임의 id 차단).
    const itemsSigned = itemsOut.map((item) => {
      const contentId = newsContentId(item.link, item.originalLink);
      const viewToken = contentId ? signContentView("news", contentId) : null;
      return viewToken ? { ...item, viewToken } : item;
    });
    return NextResponse.json({ items: itemsSigned, _q: searchQuery });
  } catch (e: unknown) {
    console.error('[API/news] Fetch error:', (e as Error).message);
    return NextResponse.json({ items: [], error: (e as Error).message, _q: searchQuery });
  }
}
