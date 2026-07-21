import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";

// POST: 직관 스토리 신고 — DB RPC 로 insert+증가+임계 숨김을 한 트랜잭션 원자 처리
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
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 100) : "기타";
  const detail = typeof body.detail === "string" ? body.detail.slice(0, 500) : null;
  if (!Number.isInteger(storyId)) {
    return NextResponse.json({ error: "잘못된 id" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("report_venue_story", {
    p_story_id: storyId,
    p_reporter: verified.user.id,
    p_reason: reason,
    p_detail: detail,
  });

  if (error) {
    return NextResponse.json({ error: "신고 실패" }, { status: 500 });
  }
  const result = (data ?? {}) as { ok?: boolean; error?: string; hidden?: boolean; alreadyReported?: boolean };
  if (result.ok === false) {
    return NextResponse.json({ error: result.error === "not_found" ? "없는 스토리" : "신고 실패" }, { status: 404 });
  }

  return NextResponse.json({
    success: true,
    hidden: !!result.hidden,
    alreadyReported: !!result.alreadyReported,
  });
}
