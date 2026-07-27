import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/polls — 투표글 생성 (spec: specs/community-poll.md §5)
 *
 * body: {
 *   title: string,                // 질문(필수)
 *   content?: string,             // 설명(선택)
 *   allowMultiple?: boolean,      // 복수선택 허용
 *   closesAt: string,             // ISO8601 (서버 RPC가 10분~30일 검증)
 *   options: { kind: 'team'|'player'|'etc', refId?: string, label?: string, image?: string }[]
 * }
 *
 * 인증(JWT) 필수. 검증(옵션 2~10, 팀+선수 공존 금지, closes 범위, etc label,
 * ref_id)은 전부 create_poll RPC(SECURITY DEFINER, service-role 전용)가 SSOT로 수행.
 */

// RPC(RAISE EXCEPTION) SQLSTATE → HTTP 매핑. check/FK 위반은 사용자 입력 문제(400).
function rpcErrorStatus(code?: string): number {
  switch (code) {
    case "23514": // check_violation
    case "23503": // foreign_key_violation
    case "22P02": // invalid_text_representation (e.g. bad uuid)
      return 400;
    case "P0002": // no_data_found
      return 404;
    default:
      return 500;
  }
}

type OptionInput = { kind?: unknown; refId?: unknown; label?: unknown; image?: unknown };

export async function POST(request: NextRequest) {
  const verified = await getVerifiedUserFromRequest(request);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  let body: {
    title?: unknown;
    content?: unknown;
    allowMultiple?: unknown;
    closesAt?: unknown;
    options?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문" }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return NextResponse.json({ error: "질문(title)은 필수입니다" }, { status: 400 });
  }
  if (typeof body.closesAt !== "string" || Number.isNaN(Date.parse(body.closesAt))) {
    return NextResponse.json({ error: "마감시간(closesAt)이 올바르지 않습니다" }, { status: 400 });
  }
  if (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > 10) {
    return NextResponse.json({ error: "선지는 2~10개여야 합니다" }, { status: 400 });
  }

  // route 레벨 얇은 정규화 — 권위 검증은 RPC.
  const options = (body.options as OptionInput[]).map((o) => ({
    kind: typeof o.kind === "string" ? o.kind : null,
    ref_id: typeof o.refId === "string" && o.refId.trim() ? o.refId.trim() : null,
    label: typeof o.label === "string" && o.label.trim() ? o.label.trim() : null,
    image: typeof o.image === "string" && o.image.trim() ? o.image.trim() : null,
  }));

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("create_poll", {
    p_author_id: verified.user.id,
    p_title: title,
    p_content: typeof body.content === "string" ? body.content : null,
    p_allow_multiple: body.allowMultiple === true,
    p_closes_at: new Date(body.closesAt).toISOString(),
    p_options: options,
  });

  if (error) {
    const status = rpcErrorStatus(error.code);
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ postId: Number(data) }, { status: 201 });
}
