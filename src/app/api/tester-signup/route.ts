import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 현재 유저의 기존 신청 내역 조회 */
export async function GET(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("tester_signups")
    .select("play_store_email, created_at")
    .eq("user_id", verified.user.id)
    .maybeSingle();

  if (error) return supabaseErrorResponse(error);

  return NextResponse.json({
    signed: !!data,
    playStoreEmail: data?.play_store_email ?? null,
  });
}

/** 테스터 신청 (1인 1신청, 이메일 변경 시 upsert로 갱신) */
export async function POST(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  const { playStoreEmail, deviceInfo } = await req.json();
  const email =
    typeof playStoreEmail === "string" ? playStoreEmail.trim().toLowerCase() : "";

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return NextResponse.json(
      { error: "올바른 이메일 주소를 입력해주세요" },
      { status: 400 },
    );
  }

  const { error } = await supabase.from("tester_signups").upsert(
    {
      user_id: verified.user.id,
      account_email: verified.user.email ?? null,
      play_store_email: email,
      device_info: typeof deviceInfo === "string" ? deviceInfo.slice(0, 500) : null,
    },
    { onConflict: "user_id" },
  );

  if (error) return supabaseErrorResponse(error);

  return NextResponse.json({ success: true });
}
