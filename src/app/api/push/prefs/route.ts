import { NextRequest, NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { PREF_KEYS, DEFAULT_PREFS, type NotificationPrefs } from "@/lib/notifications/prefs";

// 알림 종류별 on/off 설정 (push-notifications-v1 S2).
// row 없음 = 디폴트(전부 on, 이닝 묶음 요약만 off)

const SELECT_COLS = PREF_KEYS.join(",");

// error를 호출자에 전파 — 테이블/마이그레이션 문제를 디폴트 성공처럼 숨기지 않는다
// (PR #206 리뷰 blocker 2)
async function fetchPrefs(userId: string): Promise<{ prefs: Partial<NotificationPrefs>; error: PostgrestError | null }> {
  const { data, error } = await supabase
    .from("notification_prefs")
    .select(SELECT_COLS)
    .eq("user_id", userId)
    .maybeSingle();
  return { prefs: (data as Partial<NotificationPrefs> | null) ?? {}, error };
}

export async function GET(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified?.user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { prefs: saved, error } = await fetchPrefs(verified.user.id);
  if (error) return supabaseErrorResponse(error);
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
  const { prefs: saved, error: readError } = await fetchPrefs(verified.user.id);
  if (readError) return supabaseErrorResponse(readError);
  const { error } = await supabase.from("notification_prefs").upsert({
    user_id: verified.user.id,
    ...DEFAULT_PREFS,
    ...saved,
    ...updates,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });

  if (error) return supabaseErrorResponse(error);

  // W3c: "잠금화면 실시간 중계"를 끄면 기존 Live Activity push token도 정리(stale 방지).
  if (updates.live_activity === false) {
    await supabase.from("live_activity_tokens").delete().eq("user_id", verified.user.id);
  }

  return NextResponse.json({ success: true, prefs: { ...DEFAULT_PREFS, ...saved, ...updates } });
}
