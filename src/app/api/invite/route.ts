import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseErrorResponse } from "@/lib/supabase/error";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "KBO-";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// POST: 초대코드 생성
export async function POST(req: NextRequest) {
  const { userId } = await req.json();
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  // 남은 초대권 확인
  const { data: profile } = await supabase
    .from("profiles")
    .select("invite_count")
    .eq("id", userId)
    .single();

  if (!profile || (profile.invite_count ?? 0) <= 0) {
    return NextResponse.json({ error: "초대권이 없습니다" }, { status: 403 });
  }

  // 코드 생성
  const code = generateCode();
  const { error } = await supabase.from("invitations").insert({
    code,
    inviter_id: userId,
  });

  if (error) return supabaseErrorResponse(error);

  // 초대권 차감
  await supabase
    .from("profiles")
    .update({ invite_count: (profile.invite_count ?? 1) - 1 })
    .eq("id", userId);

  return NextResponse.json({ code });
}

// GET: 내 초대 현황
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId");
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const { data: invitations } = await supabase
    .from("invitations")
    .select("code, used_at, invitee_id, created_at")
    .eq("inviter_id", userId)
    .order("created_at", { ascending: false });

  // 초대한 친구 닉네임
  const usedInvites = (invitations || []).filter(i => i.invitee_id);
  const friendIds = usedInvites.map(i => i.invitee_id);
  
  let friends: { id: string; nickname: string }[] = [];
  if (friendIds.length > 0) {
    const { data } = await supabase
      .from("profiles")
      .select("id, nickname")
      .in("id", friendIds);
    friends = data || [];
  }

  return NextResponse.json({
    invitations: invitations || [],
    friends,
    totalInvited: usedInvites.length,
  });
}
