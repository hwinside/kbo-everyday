import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/polls/[postId]/vote — 투표/변경 (spec §5)
 *
 * body: { optionIds: number[] }
 * 인증(JWT) 필수. 마감·빈선택·중복·단일선택 위반·타 poll 옵션은 전부
 * cast_poll_vote RPC(SECURITY DEFINER, poll-row lock)가 DB에서 fail-closed 검증.
 */

function rpcErrorStatus(code?: string): number {
  switch (code) {
    case "23514": // check_violation (closed/empty/duplicate/single-select)
    case "23503": // foreign_key_violation (option not in this poll)
    case "23505": // unique_violation
    case "22P02": // invalid uuid/int
      return 400;
    case "P0002": // no_data_found (poll not found)
      return 404;
    default:
      return 500;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  const verified = await getVerifiedUserFromRequest(request);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  const { postId } = await params;
  const id = Number(postId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid postId" }, { status: 400 });
  }

  let body: { optionIds?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문" }, { status: 400 });
  }

  if (
    !Array.isArray(body.optionIds) ||
    body.optionIds.length === 0 ||
    !body.optionIds.every((v) => Number.isInteger(v) && (v as number) > 0)
  ) {
    return NextResponse.json({ error: "선택한 선지(optionIds)가 올바르지 않습니다" }, { status: 400 });
  }

  const optionIds = body.optionIds as number[];

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.rpc("cast_poll_vote", {
    p_post_id: id,
    p_user_id: verified.user.id,
    p_option_ids: optionIds,
  });

  if (error) {
    const status = rpcErrorStatus(error.code);
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ success: true });
}
