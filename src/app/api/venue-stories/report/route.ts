import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { VENUE_STORY_REPORT_HIDE_THRESHOLD } from "@/lib/venue-stories/types";

// POST: 직관 스토리 신고 → reports 테이블 기록 + report_count++, 임계치 이상이면 자동 숨김
export async function POST(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청" }, { status: 400 });
  }

  const storyId = Number(body.storyId);
  const reason = typeof body.reason === "string" ? body.reason : "기타";
  const detail = typeof body.detail === "string" ? body.detail.slice(0, 500) : null;
  if (!Number.isInteger(storyId)) {
    return NextResponse.json({ error: "잘못된 id" }, { status: 400 });
  }

  // 대상 존재 확인
  const { data: story } = await supabase
    .from("venue_stories")
    .select("id, report_count, status")
    .eq("id", storyId)
    .maybeSingle();
  if (!story) {
    return NextResponse.json({ error: "없는 스토리" }, { status: 404 });
  }

  // reports 테이블 기록 (중복 신고는 unique 위반으로 409 — 기존 report 패턴 재활용)
  const { error: reportErr } = await supabase.from("reports").insert({
    reporter_id: verified.user.id,
    target_type: "venue_story",
    target_id: String(storyId),
    reason,
    detail,
  });
  if (reportErr) {
    // 이미 신고한 경우(unique 위반)는 조용히 성공 처리
    const code = (reportErr as { code?: string }).code;
    if (code !== "23505") {
      return NextResponse.json({ error: "신고 실패" }, { status: 500 });
    }
    return NextResponse.json({ success: true, alreadyReported: true });
  }

  const nextCount = ((story.report_count as number) ?? 0) + 1;
  const shouldHide = nextCount >= VENUE_STORY_REPORT_HIDE_THRESHOLD;
  await supabase
    .from("venue_stories")
    .update({
      report_count: nextCount,
      ...(shouldHide ? { status: "removed" } : {}),
    })
    .eq("id", storyId);

  return NextResponse.json({ success: true, hidden: shouldHide });
}
