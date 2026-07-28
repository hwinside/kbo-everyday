import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { fetchPollSummaries } from "@/lib/community/poll";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/polls/summaries — 목록 카드용 poll 요약 배치 조회 (spec §5, §6, S3)
 *
 * body: { postIds: number[] } (≤100)
 * 응답: { summaries: Record<postId, PollSummary> }
 *
 * poll_polls/poll_options 는 RLS 전면 차단이므로 service-role admin 으로만 읽는다.
 * 득표수(vote_count)는 반환하지 않는다 — 목록/OG 에서 진행중 결과 우회 노출 방지.
 * hidden/비-poll 은 결과에서 제외. 인증 불필요(공개 목록 메타: 질문·선지·마감·참여수).
 */
export async function POST(request: NextRequest) {
  let body: { postIds?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문" }, { status: 400 });
  }

  if (!Array.isArray(body.postIds)) {
    return NextResponse.json({ error: "postIds 배열이 필요합니다" }, { status: 400 });
  }
  const postIds = (body.postIds as unknown[])
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0);

  const admin = getSupabaseAdmin();
  const summaries = await fetchPollSummaries(admin, postIds);

  const res = NextResponse.json({ summaries });
  // 참여수/마감은 시간에 따라 변하므로 짧은 공유 캐시만 허용(득표수 미포함이라 유저별 아님).
  res.headers.set("Cache-Control", "public, max-age=15, s-maxage=15");
  return res;
}
