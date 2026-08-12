import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { verifyAccessToken } from "@/lib/auth/verified-user";
import {
  resolveViewerKey,
  isVenueStoryViewKind,
  venueStoryViewRecordStatus,
} from "@/lib/venue-stories/view-tracking";

// POST: 직관 스토리 조회 기록 (A안 원문: click/impression 2종, #735 패턴 이식 · 2026-07-29)
// - 뷰어 열람 = click, 트레이 실제 노출(≥50%+0.5s) = impression. 클라가 sendBeacon(우선)/
//   fetch keepalive 로 호출.
// - dedupe(스토리×뷰어×kind×KST일 1회)는 DB RPC(record_venue_story_view)가 원자 처리.
// - 비로그인도 집계: body.guestId(#735 과 같은 localStorage 영속 UUID) → `guest:{uuid}`.
//   IP/NAT 파생 키 금지. 유효 식별자가 없으면 조용히 미집계.
// - sendBeacon 은 커스텀 헤더를 못 실으므로 인증 토큰도 body(accessToken)로 받는다
//   (HTTPS 동일 오리진 — Authorization 헤더와 노출면 동일). 유효 토큰이면 `user:{id}` 우선.
// - 없는/removed 스토리는 RPC 내부에서 조용히 no-op(존재 여부 정보 누출 없음) — 204.
// - RPC 실패는 **5xx 로 반환**(성공 위장 금지 — 데이터 유실 결함 수정): 클라 폴백 fetch 가
//   비정상 응답을 보고 mark 를 해제해 재시도할 수 있다(서버 dedupe 로 과집계 없음).
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
  let body: { kind?: unknown; guestId?: unknown; accessToken?: unknown } = {};
  try {
    const raw = await req.text();
    if (raw) body = JSON.parse(raw) as typeof body;
  } catch {
    // 파싱 실패 → 아래 kind 검증에서 400
  }

  if (!isVenueStoryViewKind(body.kind)) {
    return NextResponse.json({ error: "kind must be 'click' or 'impression'" }, { status: 400 });
  }

  // 인증 유저 식별(있으면 guest 보다 우선). 토큰 검증 실패는 그 토큰만 무시 — guestId 가
  // 함께 오면 guest 로 집계(부가 지표, 거부보다 유실 최소화 우선).
  let userId: string | null = null;
  const token = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
  if (token && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    // sendBeacon 경로라 클라가 실패를 못 멈춤 — dead-token 가드 경유가 유일한 방어.
    const user = await verifyAccessToken(token);
    if (user) userId = user.id;
  }

  const viewerKey = resolveViewerKey(userId, body.guestId);
  if (!viewerKey) {
    // 유효한 식별자 없음(비UUID guest 등) — 집계 없이 조용히 종료.
    return new NextResponse(null, { status: 204 });
  }

  const { error } = await supabase.rpc("record_venue_story_view", {
    p_story_id: storyId,
    p_viewer_key: viewerKey,
    p_kind: body.kind,
  });
  if (error) {
    // 성공 위장(204) 금지 — 클라 재시도 경로가 살아있도록 5xx. 로그로 서버 관측도 남긴다.
    console.error("[venue-story-view] record failed:", {
      storyId,
      kind: body.kind,
      error: error.message,
    });
    return NextResponse.json(
      { error: "기록 실패" },
      { status: venueStoryViewRecordStatus(error) },
    );
  }

  return new NextResponse(null, { status: venueStoryViewRecordStatus(null) });
}
