import { getClientIp } from "@/lib/http/client-ip";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { allowViewRequest } from "@/lib/community/view-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/posts/[postId]/view  { kind: "click" | "impression" }
 *
 * 게시글 조회수 카운터 +1. 전체 유저 대상(비로그인 포함) 공개 엔드포인트.
 * 표시(관리자 전용)는 클라 게이트(ADMIN_EMAILS)에서 처리 — 여기선 순수 증가만.
 * 중복 방지(세션당 임프레션 1회 등)는 호출부(클라)가 담당한다.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  const { postId } = await params;
  const id = Number(postId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid postId" }, { status: 400 });
  }

  let kind: unknown;
  try {
    kind = (await request.json())?.kind;
  } catch {
    kind = undefined;
  }
  if (kind !== "click" && kind !== "impression") {
    return NextResponse.json({ error: "kind must be 'click' or 'impression'" }, { status: 400 });
  }

  // 경량 abuse cap(인스턴스 로컬 best-effort): 같은 요청자+post+kind 1초 폭주 차단.
  // 실제 오염 방어의 주축은 RPC service_role only(v2 마이그레이션)이다.
  const viewerToken =
    getClientIp(request, { allowRealIp: true });
  if (!allowViewRequest(viewerToken, id, kind)) {
    return NextResponse.json({ ok: false, throttled: true }, { status: 200 });
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.rpc("increment_post_view", { p_post_id: id, p_kind: kind });
  if (error) {
    // 집계 실패가 UX를 막지 않도록 조용히 200(no-op)으로 흘린다 — best-effort 텔레메트리.
    // 단, 서버 관측을 위해 최소 로그는 남긴다(삼순 blocker4).
    console.error("[post-view] increment_post_view failed", { postId: id, kind, error: error.message });
    return NextResponse.json({ ok: false }, { status: 200 });
  }
  return NextResponse.json({ ok: true });
}
