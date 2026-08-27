import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";

export async function POST(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  const { code: rawCode, fingerprint } = await req.json();
  const userId = verified.user.id;
  // 기존 KBO- 코드 호환: 입력값 정규화
  const code = rawCode?.replace(/^KBO-/i, "KEUBO-");
  const ipAddress = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  if (!code) {
    return NextResponse.json({ error: "code required" }, { status: 400 });
  }

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

  if (invitation.inviter_id === userId) {
    return NextResponse.json({ error: "본인의 초대코드는 사용할 수 없습니다" }, { status: 403 });
  }

  const { data: existingProfile } = await supabase
    .from("profiles")
    .select("invited_by")
    .eq("id", userId)
    .single();

  if (existingProfile?.invited_by) {
    return NextResponse.json({ error: "이미 초대코드가 등록된 계정입니다" }, { status: 409 });
  }

  let flagged = false;
  let flaggedReason: string | null = null;

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

  await supabase.from("invite_abuse_check").insert({
    invitee_id: userId,
    fingerprint: fingerprint || null,
    ip_address: ipAddress !== "unknown" ? ipAddress : null,
  });

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

  // 파운더 배지 부여 중단 (2026-08-24 하린아빠 지시)
  // — "초창기 멤버" 취지와 달리 초대 가입만으로 계속 부여되고 있어 신규 부여를 멈춘다.
  // 기존 보유자(is_founder / user_badges)는 건드리지 않는다.
  await supabase
    .from("profiles")
    .update({
      invited_by: invitation.inviter_id,
    })
    .eq("id", userId);

  return NextResponse.json({ success: true, flagged });
}
