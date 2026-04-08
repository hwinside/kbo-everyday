import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

const ADMIN_PIN = process.env.ADMIN_PIN || "kbo2025";

function checkPin(request: NextRequest) {
  const pin = request.headers.get("x-admin-pin") || "";
  return pin === ADMIN_PIN;
}

// GET: 운영팀 계정의 대화 목록 + 메시지
export async function GET(request: NextRequest) {
  if (!checkPin(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const systemUserId = process.env.SYSTEM_USER_ID;
  if (!serviceKey || !systemUserId) {
    return NextResponse.json({ error: "missing_config" }, { status: 500 });
  }

  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey);
  const conversationId = request.nextUrl.searchParams.get("conversationId");

  // 개별 대화 메시지 조회
  if (conversationId) {
    // 운영팀 대화인지 검증
    const { data: conv } = await admin
      .from("dm_conversations")
      .select("id, user1_id, user2_id")
      .eq("id", conversationId)
      .or(`user1_id.eq.${systemUserId},user2_id.eq.${systemUserId}`)
      .maybeSingle();

    if (!conv) {
      return NextResponse.json({ error: "not_found_or_unauthorized" }, { status: 403 });
    }

    const { data: messages } = await admin
      .from("dm_messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(200);

    // sender profiles batch fetch
    const senderIds = [...new Set((messages ?? []).map((m: { sender_id: string }) => m.sender_id))];
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, nickname, team_id")
      .in("id", senderIds);

    const profileMap = new Map(
      (profiles ?? []).map((p: { id: string; nickname: string; team_id: number | null }) => [p.id, p])
    );

    const enriched = (messages ?? []).map((m: { sender_id: string; [key: string]: unknown }) => ({
      ...m,
      sender_nickname: profileMap.get(m.sender_id)?.nickname ?? "알 수 없음",
      is_system: m.sender_id === systemUserId,
    }));

    return NextResponse.json({ messages: enriched });
  }

  // 대화 목록 조회
  const { data: convs } = await admin
    .from("dm_conversations")
    .select("*")
    .or(`user1_id.eq.${systemUserId},user2_id.eq.${systemUserId}`)
    .order("last_message_at", { ascending: false });

  if (!convs || convs.length === 0) {
    return NextResponse.json({ conversations: [] });
  }

  // 상대방 profiles batch fetch
  const otherIds = convs.map((c: { user1_id: string; user2_id: string }) =>
    c.user1_id === systemUserId ? c.user2_id : c.user1_id
  );
  const { data: profiles } = await admin
    .from("profiles")
    .select("id, nickname, team_id")
    .in("id", otherIds);

  const profileMap = new Map(
    (profiles ?? []).map((p: { id: string; nickname: string; team_id: number | null }) => [p.id, p])
  );

  // unread counts
  const convIds = convs.map((c: { id: string }) => c.id);
  const { data: unreadRows } = await admin
    .from("dm_messages")
    .select("conversation_id")
    .in("conversation_id", convIds)
    .eq("is_read", false)
    .neq("sender_id", systemUserId);

  const unreadMap = new Map<string, number>();
  (unreadRows ?? []).forEach((r: { conversation_id: string }) => {
    unreadMap.set(r.conversation_id, (unreadMap.get(r.conversation_id) ?? 0) + 1);
  });

  const mapped = convs.map((c: { id: string; user1_id: string; user2_id: string; last_message: string | null; last_message_at: string }) => {
    const otherId = c.user1_id === systemUserId ? c.user2_id : c.user1_id;
    const prof = profileMap.get(otherId);
    return {
      id: c.id,
      other_user_id: otherId,
      other_nickname: prof?.nickname ?? "알 수 없음",
      other_team_id: prof?.team_id ?? null,
      last_message: c.last_message,
      last_message_at: c.last_message_at,
      unread_count: unreadMap.get(c.id) ?? 0,
    };
  });

  return NextResponse.json({ conversations: mapped });
}

// POST: 운영팀 계정으로 답장
export async function POST(request: NextRequest) {
  if (!checkPin(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const systemUserId = process.env.SYSTEM_USER_ID;
  if (!serviceKey || !systemUserId) {
    return NextResponse.json({ error: "missing_config" }, { status: 500 });
  }

  const { conversationId, content } = await request.json();
  if (!conversationId || !content?.trim()) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey);

  // 운영팀 대화인지 검증
  const { data: conv } = await admin
    .from("dm_conversations")
    .select("id")
    .eq("id", conversationId)
    .or(`user1_id.eq.${systemUserId},user2_id.eq.${systemUserId}`)
    .maybeSingle();

  if (!conv) {
    return NextResponse.json({ error: "not_found_or_unauthorized" }, { status: 403 });
  }

  const { error: msgError } = await admin
    .from("dm_messages")
    .insert({
      conversation_id: conversationId,
      sender_id: systemUserId,
      content: content.trim(),
    });

  if (msgError) {
    return NextResponse.json({ error: "send_failed" }, { status: 500 });
  }

  await admin
    .from("dm_conversations")
    .update({
      last_message: content.trim().substring(0, 100),
      last_message_at: new Date().toISOString(),
    })
    .eq("id", conversationId);

  return NextResponse.json({ ok: true });
}
