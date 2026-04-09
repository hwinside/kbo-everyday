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

// Lazy 리필 체크: 초대권 0이면 조건 충족 시 +3 리필
async function tryLazyRefill(userId: string, currentCount: number): Promise<number> {
  if (currentCount > 0) return currentCount;

  // 활성화 초대 1건 이상?
  const { count: activatedCount } = await supabase
    .from("invitations")
    .select("*", { count: "exact", head: true })
    .eq("inviter_id", userId)
    .not("activated_at", "is", null)
    .neq("flagged", true);

  if (!activatedCount || activatedCount < 1) return 0;

  // 오늘(KST) 리필 이력 체크
  const todayKST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  todayKST.setHours(0, 0, 0, 0);
  const { count: refillToday } = await supabase
    .from("invite_refill_log")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("refilled_at", todayKST.toISOString());

  if (refillToday && refillToday > 0) return 0;

  // 리필 실행
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

  if (!profile) {
    return NextResponse.json({ error: "프로필을 찾을 수 없습니다" }, { status: 404 });
  }

  // Lazy 리필 시도
  const availableCount = await tryLazyRefill(userId, profile.invite_count ?? 0);
  if (availableCount <= 0) {
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
    .update({ invite_count: availableCount - 1 })
    .eq("id", userId);

  return NextResponse.json({ code });
}

// GET: 내 초대 현황
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId");
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

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

  // 활성화 초대 수 (flagged 제외)
  const { count: activatedCount } = await supabase
    .from("invitations")
    .select("*", { count: "exact", head: true })
    .eq("inviter_id", userId)
    .not("activated_at", "is", null)
    .neq("flagged", true);

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
    activatedCount: activatedCount || 0,
    remainingCodes: profile?.invite_count ?? 0,
  });
}
