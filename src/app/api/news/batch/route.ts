import { NextRequest, NextResponse } from "next/server";
import { withNewsViewTokensEdge } from "@/lib/content-views/sign-edge";
import type { NaverNewsRawItem, NewsItem } from "@/types/api";
import {
  isPlayerBaseballRelevant,
  isTeamBaseballRelevant,
  isNaverNewsUrl,
  dedupeNewsByTitle,
} from "@/lib/news-relevance";

export const runtime = "edge";

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

// shortName → 검색용 풀네임 + 마스코트. 팀 뉴스는 마스코트 게이트로
// LG그룹·삼성전자 등 동음 기업 기사(예: 젠슨 황 시구 기사가 "프로야구"를
// 본문에 달고 들어오는 케이스)를 걸러낸다. relevance 로직은 news-relevance에 SSOT.
const TEAM_INFO: Record<string, { full: string; mascot: string }> = {
  LG: { full: "LG 트윈스", mascot: "트윈스" },
  두산: { full: "두산 베어스", mascot: "베어스" },
  KT: { full: "KT 위즈", mascot: "위즈" },
  SSG: { full: "SSG 랜더스", mascot: "랜더스" },
  NC: { full: "NC 다이노스", mascot: "다이노스" },
  KIA: { full: "KIA 타이거즈", mascot: "타이거즈" },
  롯데: { full: "롯데 자이언츠", mascot: "자이언츠" },
  삼성: { full: "삼성 라이온즈", mascot: "라이온즈" },
  한화: { full: "한화 이글스", mascot: "이글스" },
  키움: { full: "키움 히어로즈", mascot: "히어로즈" },
};

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
    const items: NewsItem[] = (data.items || [])
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
    const queries: {
      query: string;
      label: string;
      isPlayer: boolean;
      mascot?: string;
    }[] = [];

    if (team) {
      const info = TEAM_INFO[team];
      queries.push({
        query: `프로야구 ${info?.full || team}`,
        label: team,
        isPlayer: false,
        mascot: info?.mascot,
      });
    }

    for (const p of players.slice(0, 5)) {
      queries.push({
        query: `${p.teamName} ${p.name}`,
        label: p.name,
        isPlayer: true,
      });
    }

    const results = await Promise.all(
      queries.map(async (q) => {
        const items = await fetchNews(q.query);
        return items.map((item) => ({
          ...item,
          _label: q.label,
          _isPlayer: q.isPlayer,
          _mascot: q.mascot,
        }));
      })
    );

    type LabeledItem = NewsItem & {
      _label: string;
      _isPlayer: boolean;
      _mascot?: string;
    };

    // 중복 제거 + relevance 필터 + 선수별 균등 분배
    const seen = new Set<string>();
    const dedup = (items: LabeledItem[]) =>
      items.filter((item) => {
        if (seen.has(item.link)) return false;
        seen.add(item.link);
        return true;
      });
    const relevantOnly = (items: LabeledItem[]) =>
      items.filter((item) =>
        item._isPlayer
          ? isPlayerBaseballRelevant(item.title, item.description, item._label)
          : isTeamBaseballRelevant(item.title, item.description, item._mascot)
      );

    // 팀 뉴스는 첫 번째, 나머지는 선수별. filter→slice 순서로 잡음 자리 채움.
    const teamItems =
      results[0] && team ? relevantOnly(dedup(results[0])).slice(0, 5) : [];
    const playerItems = results
      .slice(team ? 1 : 0)
      .flatMap((items) => relevantOnly(dedup(items)).slice(0, 3));

    const allItems = [...playerItems, ...teamItems];
    allItems.sort(
      (a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime()
    );

    // 매체만 다른 같은 사건 기사(near-duplicate) 제거 — 최신순이라 첫(최신) 항목 유지
    const deduped = dedupeNewsByTitle(allItems);

    // 조회수 서명 부착 — 홈 캐러셀이 쓰는 batch 종단(삼순 2차 — 배선 누락 결손 방지).
    return NextResponse.json({ items: await withNewsViewTokensEdge(deduped.slice(0, 10)) });
  } catch {
    return NextResponse.json({ items: [] });
  }
}
