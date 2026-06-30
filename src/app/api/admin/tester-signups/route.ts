import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/admin/pin";

function normalizeContent(content: unknown) {
  return typeof content === "string" ? content.replace(/\r\n/g, "\n").trimEnd() : "";
}

/** 테스터 신청자 목록 (어드민 PIN 인증) */
export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("tester_signups")
    .select("id, user_id, account_email, play_store_email, device_info, created_at, dm_sent_at, dm_conversation_id")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

/** 테스터 신청자에게 다운로드 안내 쪽지를 보내고 발송 상태를 영구 저장 */
export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const systemUserId = process.env.SYSTEM_USER_ID;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !systemUserId) {
    return NextResponse.json({ error: "missing_config" }, { status: 500 });
  }

  const body = await req.json();
  const id = Number(body.id);
  const content = normalizeContent(body.content);
  if (body.action !== "send_dm" || !Number.isInteger(id) || id <= 0 || !content.trim()) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { data: signup, error: signupError } = await supabase
    .from("tester_signups")
    .select("id, user_id, dm_sent_at, dm_conversation_id")
    .eq("id", id)
    .maybeSingle();

  if (signupError) return NextResponse.json({ error: signupError.message }, { status: 500 });
  if (!signup) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (signup.dm_sent_at) {
    return NextResponse.json({
      ok: true,
      alreadySent: true,
      sentAt: signup.dm_sent_at,
      conversationId: signup.dm_conversation_id,
    });
  }

  const [u1, u2] = [systemUserId, signup.user_id].sort();
  const { data: existingConv } = await supabase
    .from("dm_conversations")
    .select("id")
    .eq("user1_id", u1)
    .eq("user2_id", u2)
    .maybeSingle();

  let conversationId: string;
  if (existingConv) {
    conversationId = existingConv.id;
  } else {
    const { data: newConv, error: convError } = await supabase
      .from("dm_conversations")
      .insert({ user1_id: u1, user2_id: u2 })
      .select("id")
      .single();

    if (convError || !newConv) {
      return NextResponse.json({ error: "conv_create_failed" }, { status: 500 });
    }
    conversationId = newConv.id;
  }

  const { data: message, error: msgError } = await supabase
    .from("dm_messages")
    .insert({
      conversation_id: conversationId,
      sender_id: systemUserId,
      content,
    })
    .select("created_at")
    .single();

  if (msgError || !message) {
    return NextResponse.json({ error: "send_failed" }, { status: 500 });
  }

  const sentAt = message.created_at ?? new Date().toISOString();
  await supabase
    .from("dm_conversations")
    .update({
      last_message: content.trim().replace(/\s+/g, " ").substring(0, 100),
      last_message_at: sentAt,
    })
    .eq("id", conversationId);

  const { error: markError } = await supabase
    .from("tester_signups")
    .update({ dm_sent_at: sentAt, dm_conversation_id: conversationId })
    .eq("id", id);

  if (markError) {
    return NextResponse.json({ error: "message_sent_but_marker_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, sentAt, conversationId });
}
