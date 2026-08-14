import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { allowViewRequest } from "@/lib/community/view-rate-limit";
import { isContentViewType, isValidContentId } from "@/lib/content-views/policy";
import { verifyContentViewToken } from "@/lib/content-views/sign";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/content-views/view  { type: "shorts" | "news", id: string, token: string }
 *
 * 콘텐츠(숏츠·뉴스) 조회수 카운터 +1. 전체 유저 대상(비로그인 포함) 공개 엔드포인트.
 * 표시(관리자 전용)는 서버 인가된 /counts 가 담당 — 여기선 순수 증가만.
 *
 * 임의 content_id 차단(삼순 blocker3): token 은 콘텐츠 목록을 실제 서빙한 서버
 * route(/api/news·/api/shorts-feed·/api/team-videos)가 발급한 HMAC 서명이다.
 * 서명이 유효한 키만 증가 → 집계 가능한 행 집합이 서버가 내보낸 콘텐츠로 한정되어
 * id 변조로 rate-limit 을 우회하는 무한 행 생성·수치 오염이 불가능하다.
 * 세션 dedup(숏츠)은 호출부(클라)가 담당. 게시글 view route와 동일한 best-effort 축.
 */
export async function POST(request: NextRequest) {
  let type: unknown;
  let id: unknown;
  let token: unknown;
  try {
    const body = await request.json();
    type = body?.type;
    id = body?.id;
    token = body?.token;
  } catch {
    /* invalid json → 아래 검증에서 400 */
  }
  if (!isContentViewType(type)) {
    return NextResponse.json({ error: "type must be 'shorts' or 'news'" }, { status: 400 });
  }
  if (!isValidContentId(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  if (!verifyContentViewToken(type, id, token)) {
    return NextResponse.json({ error: "invalid token" }, { status: 403 });
  }

  // 경량 abuse cap(인스턴스 로컬 best-effort): 같은 요청자+콘텐츠 1초 폭주 차단.
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
