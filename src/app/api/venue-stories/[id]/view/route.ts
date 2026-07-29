import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";

// POST: 직관 스토리 조회 기록 (운영 분석용, A안 2026-07-29)
// - 뷰어가 스토리를 표시할 때 fire-and-forget 으로 호출.
// - dedupe(스토리×뷰어×KST일 1회)는 DB RPC(record_venue_story_view)가 원자 처리.
// - 없는/removed 스토리는 RPC 내부에서 조용히 no-op — 존재 여부 정보 누출 없이 항상 204.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  const { id } = await params;
  const storyId = Number(id);
  if (!Number.isInteger(storyId) || storyId <= 0) {
    return NextResponse.json({ error: "잘못된 id" }, { status: 400 });
  }

  // 실패해도 뷰어 UX 에 영향 없어야 하는 부가 지표 — 에러도 204 로 삼킨다(로그만).
  const { error } = await supabase.rpc("record_venue_story_view", {
    p_story_id: storyId,
    p_viewer_key: verified.user.id,
  });
  if (error) {
    console.error("[venue-story-view] record failed:", error.message);
  }

  return new NextResponse(null, { status: 204 });
}
