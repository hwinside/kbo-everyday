import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase, getSupabaseAdmin } from "@/lib/supabase/admin";
import { resolveViewerKey } from "@/lib/venue-stories/view-tracking";

// POST: 직관 스토리 조회 기록 (운영 분석/관리자 노출용, A안 2026-07-29 · 삼순 게이트 반영)
// - 뷰어에서 1초 이상 노출된 스토리만 클라가 sendBeacon(우선)/fetch keepalive 로 호출.
// - dedupe(스토리×뷰어 lifetime 1회)는 DB RPC(record_venue_story_view)가 원자 처리.
// - 비로그인도 집계: body.guestId(localStorage 영속 UUID) → viewer_key `guest:{uuid}`.
//   IP/NAT 파생 키 금지(삼순 게이트 ③). 식별자 없으면 조용히 미집계.
// - sendBeacon 은 커스텀 헤더를 못 실으므로 인증 토큰도 body(accessToken)로 받는다
//   (HTTPS 동일 오리진 — Authorization 헤더와 노출면 동일). 유효 토큰이면 `user:{id}` 우선.
// - 없는/removed 스토리는 RPC 내부에서 조용히 no-op — 존재 여부 정보 누출 없이 항상 204.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const storyId = Number(id);
  if (!Number.isInteger(storyId) || storyId <= 0) {
    return NextResponse.json({ error: "잘못된 id" }, { status: 400 });
  }

  // beacon 은 text/plain 으로 오므로 text→parse (JSON Content-Type 강제하지 않음).
  let body: { guestId?: unknown; accessToken?: unknown } = {};
  try {
    const raw = await req.text();
    if (raw) body = JSON.parse(raw) as typeof body;
  } catch {
    // 파싱 실패 → 식별자 없음으로 처리(아래에서 조용히 미집계)
  }

  // 인증 유저 식별(있으면 guest 보다 우선). 토큰 검증 실패는 게스트 경로로 강등하지 않고
  // 그 토큰만 무시한다 — guestId 가 함께 오면 guest 로 집계(부가 지표, 거부보다 유실 최소화 우선).
  let userId: string | null = null;
  const token = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
  if (token && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const {
      data: { user },
      error,
    } = await getSupabaseAdmin().auth.getUser(token);
    if (!error && user) userId = user.id;
  }

  const viewerKey = resolveViewerKey(userId, body.guestId);
  if (!viewerKey) {
    // 유효한 식별자 없음(비UUID guest 등) — 집계 없이 조용히 종료.
    return new NextResponse(null, { status: 204 });
  }

  // 실패해도 뷰어 UX 에 영향 없어야 하는 부가 지표 — 에러도 204 로 삼킨다(로그만).
  const { error } = await supabase.rpc("record_venue_story_view", {
    p_story_id: storyId,
    p_viewer_key: viewerKey,
  });
  if (error) {
    console.error("[venue-story-view] record failed:", error.message);
  }

  return new NextResponse(null, { status: 204 });
}
