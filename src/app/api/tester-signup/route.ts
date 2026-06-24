import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { notifyTesterSignup } from "@/lib/tester/signup-slack";

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

  // 신규 신청 / 이메일 변경 판별용 — upsert 전 기존 행 조회
  const { data: prev } = await supabase
    .from("tester_signups")
    .select("play_store_email")
    .eq("user_id", verified.user.id)
    .maybeSingle();

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

  // 신규이거나 이메일이 바뀐 경우에만 Slack DM 알림 (동일 재제출 스팸 방지). 비차단.
  if (!prev || prev.play_store_email !== email) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("nickname")
      .eq("id", verified.user.id)
      .maybeSingle();
    await notifyTesterSignup({
      playStoreEmail: email,
      accountEmail: verified.user.email ?? null,
      nickname: (profile?.nickname as string | null) ?? null,
      deviceInfo: typeof deviceInfo === "string" ? deviceInfo : null,
      isUpdate: !!prev,
    });
  }

  return NextResponse.json({ success: true });
}
