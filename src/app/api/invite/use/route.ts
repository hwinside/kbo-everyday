import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseErrorResponse } from "@/lib/supabase/error";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// POST: 초대코드 사용 (가입 시)
export async function POST(req: NextRequest) {
  const { code, userId, fingerprint } = await req.json();
  const ipAddress =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  if (!code || !userId) {
    return NextResponse.json({ error: "code, userId required" }, { status: 400 });
  }

  // 코드 유효성 체크
  const { data: invitation, error: findError } = await supabase
    .from("invitations")
    .select("id, inviter_id, used_at")
    .eq("code", code)
    .single();

  if (findError || !invitation) {
    return NextResponse.json({ error: "유효하지 않은 초대코드입니다" }, { status: 404 });
  }

  if (invitation.used_at) {
    return NextResponse.json({ error: "이미 사용된 초대코드입니다" }, { status: 409 });
  }

  // 자기 초대 차단
  if (invitation.inviter_id === userId) {
    return NextResponse.json({ error: "본인의 초대코드는 사용할 수 없습니다" }, { status: 403 });
  }

  // 어뷰징 체크
  let flagged = false;
  let flaggedReason: string | null = null;

  // 1. fingerprint 중복 체크
  if (fingerprint) {
    const { count: fpCount } = await supabase
      .from("invite_abuse_check")
      .select("*", { count: "exact", head: true })
      .eq("fingerprint", fingerprint);

    if (fpCount && fpCount > 0) {
      flagged = true;
      flaggedReason = "fingerprint_match";
    }
  }

  // 2. IP 24시간 내 3건 이상 체크
  if (!flagged && ipAddress !== "unknown") {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count: ipCount } = await supabase
      .from("invite_abuse_check")
      .select("*", { count: "exact", head: true })
      .eq("ip_address", ipAddress)
      .gte("created_at", oneDayAgo);

    if (ipCount && ipCount >= 3) {
      flagged = true;
      flaggedReason = "ip_limit";
    }
  }

  // invite_abuse_check 기록
  await supabase.from("invite_abuse_check").insert({
    invitee_id: userId,
    fingerprint: fingerprint || null,
    ip_address: ipAddress !== "unknown" ? ipAddress : null,
  });

  // invitations 업데이트
  const updateData: Record<string, unknown> = {
    invitee_id: userId,
    used_at: new Date().toISOString(),
  };
  if (flagged) {
    updateData.flagged = true;
    updateData.flagged_reason = flaggedReason;
    updateData.flagged_at = new Date().toISOString();
  }

  const { error: updateError } = await supabase
    .from("invitations")
    .update(updateData)
    .eq("id", invitation.id);

  if (updateError) return supabaseErrorResponse(updateError);

  // profiles.invited_by 설정
  await supabase
    .from("profiles")
    .update({ invited_by: invitation.inviter_id })
    .eq("id", userId);

  return NextResponse.json({ success: true, flagged });
}
