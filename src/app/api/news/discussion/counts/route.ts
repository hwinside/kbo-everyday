import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  mapDiscussionCounts,
  NewsDiscussionInputError,
  parseCountLookups,
} from "@/lib/news/discussion";
import { allowNewsDiscussionRequest } from "@/lib/news/discussion-rate-limit";

// 댓글 개수는 공개 조회다(비로그인 포함). 남용 방지는 rate-limit이 담당한다.
//
// GET: 엣지캐시 대상(POST는 CDN이 캐시 불가). 홈 뉴스 캐러셀은 전 유저가 같은 top-10을
// 조회하므로 쿼리 정규화(정렬) 시 HIT가 대부분을 흡수한다. TTL 60초 — 댓글 수 표시는
// 60초 지연 허용 범위(카운트 배지일 뿐 댓글 본문 아님). SWR 미사용·에러 캐시 금지.
const COUNTS_CACHE_HEADERS = { "Cache-Control": "public, s-maxage=60" } as const;
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(req: NextRequest) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "discussion service unavailable" }, { status: 503, headers: NO_STORE });
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!allowNewsDiscussionRequest(`counts:${ip}`)) {
    return NextResponse.json({ error: "too many requests" }, { status: 429, headers: NO_STORE });
  }

  // 입력: ?u=<encoded canonical url> 반복 파라미터(최대 10개). 응답은 입력 url 문자열 그대로 키잉.
  const urls = req.nextUrl.searchParams.getAll("u");
  if (urls.length === 0) return NextResponse.json({ counts: {} }, { headers: COUNTS_CACHE_HEADERS });
  if (urls.length > 10) {
    return NextResponse.json({ error: "articles must contain at most 10 items" }, { status: 400, headers: NO_STORE });
  }

  let lookups: Array<{ lookupId: string; articleKey: string }>;
  try {
    lookups = parseCountLookups({
      articles: [...new Set(urls)].map((u) => ({ lookupId: u, url: u, canonicalUrl: u })),
    });
  } catch (error) {
    const message = error instanceof NewsDiscussionInputError ? error.message : "invalid request";
    return NextResponse.json({ error: message }, { status: 400, headers: NO_STORE });
  }

  const { data, error } = await getSupabaseAdmin().rpc("news_discussion_visible_counts", {
    p_article_keys: [...new Set(lookups.map((item) => item.articleKey))],
  });
  if (error) return NextResponse.json({ error: "failed to load counts" }, { status: 500, headers: NO_STORE });

  return NextResponse.json(
    {
      counts: mapDiscussionCounts(
        lookups,
        (data ?? []) as Array<{ article_key: string; visible_comment_count: number | string | null }>,
      ),
    },
    { headers: COUNTS_CACHE_HEADERS },
  );
}

export async function POST(req: NextRequest) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "discussion service unavailable" }, { status: 503 });
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!allowNewsDiscussionRequest(`counts:${ip}`)) {
    return NextResponse.json({ error: "too many requests" }, { status: 429 });
  }

  let lookups: ReturnType<typeof parseCountLookups>;
  try {
    lookups = parseCountLookups(await req.json());
  } catch (error) {
    const message = error instanceof NewsDiscussionInputError ? error.message : "invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  if (lookups.length === 0) return NextResponse.json({ counts: {} });

  const { data, error } = await getSupabaseAdmin().rpc("news_discussion_visible_counts", {
    p_article_keys: [...new Set(lookups.map((item) => item.articleKey))],
  });
  if (error) return NextResponse.json({ error: "failed to load counts" }, { status: 500 });

  return NextResponse.json({
    counts: mapDiscussionCounts(
      lookups,
      (data ?? []) as Array<{ article_key: string; visible_comment_count: number | string | null }>,
    ),
  });
}
