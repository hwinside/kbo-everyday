import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { allowViewRequest } from "@/lib/community/view-rate-limit";
import { isContentViewType, isValidContentId } from "@/lib/content-views/policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/content-views/view  { type: "shorts" | "news", id: string }
 *
 * 콘텐츠(숏츠·뉴스) 조회수 카운터 +1. 전체 유저 대상(비로그인 포함) 공개 엔드포인트.
 * 표시(관리자 전용)는 클라 게이트(ADMIN_EMAILS)에서 처리 — 여기선 순수 증가만.
 * 세션 dedup(숏츠)은 호출부(클라)가 담당. 게시글 view route와 동일 계약.
 */
export async function POST(request: NextRequest) {
  let type: unknown;
  let id: unknown;
  try {
    const body = await request.json();
    type = body?.type;
    id = body?.id;
  } catch {
    /* invalid json → 아래 검증에서 400 */
  }
  if (!isContentViewType(type)) {
    return NextResponse.json({ error: "type must be 'shorts' or 'news'" }, { status: 400 });
  }
  if (!isValidContentId(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  // 경량 abuse cap(인스턴스 로컬 best-effort): 같은 요청자+콘텐츠 1초 폭주 차단.
  // 실제 오염 방어의 주축은 RPC service_role only(마이그레이션)이다.
  const viewerToken =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  if (!allowViewRequest(viewerToken, 0, `content:${type}:${id}`)) {
    return NextResponse.json({ ok: false, throttled: true }, { status: 200 });
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.rpc("increment_content_view", {
    p_content_type: type,
    p_content_id: id,
  });
  if (error) {
    // 집계 실패가 UX를 막지 않도록 조용히 200(no-op) — best-effort 텔레메트리.
    console.error("[content-view] increment_content_view failed", {
      type,
      id: String(id).slice(0, 120),
      error: error.message,
    });
    return NextResponse.json({ ok: false }, { status: 200 });
  }
  return NextResponse.json({ ok: true });
}
