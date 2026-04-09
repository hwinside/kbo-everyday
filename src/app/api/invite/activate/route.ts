import { NextRequest, NextResponse } from "next/server";
import { checkAndActivateInvite } from "@/lib/supabase/invite-activation";

// POST: 초대 활성화 체크 (글/댓글 작성 후 호출)
export async function POST(req: NextRequest) {
  const { userId } = await req.json();
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  await checkAndActivateInvite(userId);

  return NextResponse.json({ ok: true });
}
