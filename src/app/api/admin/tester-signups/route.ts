import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isAdminAuthedRequest } from "@/lib/admin/pin";

/** 테스터 신청자 목록 (어드민 PIN 인증) */
export async function GET(req: NextRequest) {
  if (!(await isAdminAuthedRequest(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("tester_signups")
    .select("id, user_id, account_email, play_store_email, device_info, created_at, dm_sent_at")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

/** 다운로드 쪽지 발송 표시 — '발송됨'이 페이지 재진입 후에도 남도록 dm_sent_at 기록. */
export async function PATCH(req: NextRequest) {
  if (!(await isAdminAuthedRequest(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const id = body?.id;
  if (typeof id !== "number") {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("tester_signups")
    .update({ dm_sent_at: new Date().toISOString() })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
