import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(6);
  let code = "KEUBO-";
  for (let i = 0; i < 6; i++) code += chars[bytes[i] % chars.length];
  return code;
}

async function tryLazyRefill(userId: string, currentCount: number): Promise<number> {
  if (currentCount > 0) return currentCount;

  const { count: activatedCount } = await supabase
    .from("invitations")
    .select("*", { count: "exact", head: true })
    .eq("inviter_id", userId)
    .not("activated_at", "is", null)
    .neq("flagged", true);

  if (!activatedCount || activatedCount < 1) return 0;

  const todayKST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  todayKST.setHours(0, 0, 0, 0);
  const { count: refillToday } = await supabase
    .from("invite_refill_log")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("refilled_at", todayKST.toISOString());

  if (refillToday && refillToday > 0) return 0;

  const newCount = currentCount + 3;
  await supabase
    .from("profiles")
    .update({ invite_count: newCount })
    .eq("id", userId);
  await supabase
    .from("invite_refill_log")
    .insert({ user_id: userId, refilled_count: 3 });

  return newCount;
}

export async function POST(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  const userId = verified.user.id;

  const { data: profile } = await supabase
    .from("profiles")
    .select("invite_count")
    .eq("id", userId)
    .single();

  if (!profile) {
    return NextResponse.json({ error: "프로필을 찾을 수 없습니다" }, { status: 404 });
  }

  const availableCount = await tryLazyRefill(userId, profile.invite_count ?? 0);
  if (availableCount <= 0) {
    return NextResponse.json({ error: "초대권이 없습니다" }, { status: 403 });
  }

  const code = generateCode();
  const { error } = await supabase.from("invitations").insert({
    code,
    inviter_id: userId,
  });

  if (error) return supabaseErrorResponse(error);

  await supabase
    .from("profiles")
    .update({ invite_count: availableCount - 1 })
    .eq("id", userId);

  return NextResponse.json({ code });
}

export async function GET(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  const userId = verified.user.id;

  const { data: profile } = await supabase
    .from("profiles")
    .select("invite_count")
    .eq("id", userId)
    .single();

  const { data: invitations } = await supabase
    .from("invitations")
    .select("code, used_at, invitee_id, activated_at, flagged, created_at")
    .eq("inviter_id", userId)
    .order("created_at", { ascending: false });

  const { count: activatedCount } = await supabase
    .from("invitations")
    .select("*", { count: "exact", head: true })
    .eq("inviter_id", userId)
    .not("activated_at", "is", null)
    .neq("flagged", true);

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
    activatedCount: activatedCount || 0,
    remainingCodes: profile?.invite_count ?? 0,
  });
}
