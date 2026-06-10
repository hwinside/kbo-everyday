import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { PREF_KEYS, DEFAULT_PREFS, type NotificationPrefs } from "@/lib/notifications/prefs";

// 알림 종류별 on/off 설정 (push-notifications-v1 S2).
// row 없음 = 디폴트(전부 on, 이닝 묶음 요약만 off)

const SELECT_COLS = PREF_KEYS.join(",");

async function fetchPrefs(userId: string): Promise<Partial<NotificationPrefs>> {
  const { data } = await supabase
    .from("notification_prefs")
    .select(SELECT_COLS)
    .eq("user_id", userId)
    .maybeSingle();
  return (data as Partial<NotificationPrefs> | null) ?? {};
}

export async function GET(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified?.user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const saved = await fetchPrefs(verified.user.id);
  return NextResponse.json({ prefs: { ...DEFAULT_PREFS, ...saved } });
}

export async function PUT(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified?.user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const updates: Partial<NotificationPrefs> = {};
  for (const key of PREF_KEYS) {
    if (typeof body[key] === "boolean") updates[key] = body[key];
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "no valid pref keys" }, { status: 400 });
  }

  // row 없으면 디폴트에 기존 저장값 + 변경분을 얹어 생성 (부분 PUT로 디폴트 유실 방지)
  const saved = await fetchPrefs(verified.user.id);
  const { error } = await supabase.from("notification_prefs").upsert({
    user_id: verified.user.id,
    ...DEFAULT_PREFS,
    ...saved,
    ...updates,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });

  if (error) return supabaseErrorResponse(error);
  return NextResponse.json({ success: true, prefs: { ...DEFAULT_PREFS, ...saved, ...updates } });
}
