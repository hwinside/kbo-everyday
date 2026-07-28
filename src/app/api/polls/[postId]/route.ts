import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { fetchPollCore, fetchMySelection } from "@/lib/community/poll";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/polls/[postId] — 투표 상세 (spec §4, §5, §10-3)
 *
 * canSeeResults = voted ∥ closed. 이 조건에서만 선지별 vote_count 노출,
 * 아니면 voter_count(참여수)만. mySelection 이 담긴 유저별 응답은 마감 후에도
 * `Cache-Control: private, no-store` (CDN/프록시 공유 캐시 차단).
 *
 * 인증은 선택: 비로그인/미투표·진행중이면 결과 숨김. 마감 후엔 전원 열람.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  const { postId } = await params;
  const id = Number(postId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid postId" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  const core = await fetchPollCore(admin, id);
  if (!core) {
    return NextResponse.json({ error: "투표를 찾을 수 없습니다" }, { status: 404 });
  }

  // 인증은 선택. 있으면 mySelection/voted 판정에 사용.
  const verified = await getVerifiedUserFromRequest(request);
  const mySelection = verified ? await fetchMySelection(admin, id, verified.user.id) : [];
  const voted = mySelection.length > 0;
  const canSeeResults = voted || core.closed;

  const options = core.options.map((o) => ({
    id: o.id,
    position: o.position,
    kind: o.kind,
    refId: o.refId,
    label: o.label,
    image: o.image,
    // 결과 게이트: 진행중·미투표면 수치 은닉
    voteCount: canSeeResults ? o.voteCount : null,
  }));

  const bodyPayload = {
    postId: core.postId,
    title: core.title,
    content: core.content,
    allowMultiple: core.allowMultiple,
    closesAt: core.closesAt,
    closed: core.closed,
    voterCount: core.voterCount, // 항상 공개 (n명 참여)
    canSeeResults,
    voted,
    mySelection, // 유저별 → 응답은 private,no-store
    options,
  };

  const res = NextResponse.json(bodyPayload);
  // §10-3: mySelection 담긴 유저별 응답은 마감 후에도 공유 캐시 금지
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
