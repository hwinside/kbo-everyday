import { NextRequest, NextResponse } from "next/server";
import { checkAndActivateInvite } from "@/lib/supabase/invite-activation";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";

export async function POST(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  await checkAndActivateInvite(verified.user.id);

  return NextResponse.json({ ok: true });
}
