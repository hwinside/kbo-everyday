import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/admin/pin";

function checkPin(request: NextRequest) {
  return isAdminRequest(request);
}

// GET: 운영팀 계정의 대화 목록 + 메시지
export async function GET(request: NextRequest) {
  if (!checkPin(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const systemUserId = process.env.SYSTEM_USER_ID;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !systemUserId) {
    return NextResponse.json({ error: "missing_config" }, { status: 500 });
  }

  const admin = getSupabaseAdmin();
  const conversationId = request.nextUrl.searchParams.get("conversationId");
  const tab = request.nextUrl.searchParams.get("tab") || "inbox";

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

  // 각 대화의 유저 메시지 수 (운영팀이 아닌 sender) 조회
  const convIds = convs.map((c: { id: string }) => c.id);

  const { data: userMsgRows } = await admin
    .from("dm_messages")
    .select("conversation_id")
    .in("conversation_id", convIds)
    .neq("sender_id", systemUserId);

  const userMsgCountMap = new Map<string, number>();
  (userMsgRows ?? []).forEach((r: { conversation_id: string }) => {
    userMsgCountMap.set(r.conversation_id, (userMsgCountMap.get(r.conversation_id) ?? 0) + 1);
  });

  // 각 대화의 운영팀 메시지 수 조회
  const { data: sysMsgRows } = await admin
    .from("dm_messages")
    .select("conversation_id")
    .in("conversation_id", convIds)
    .eq("sender_id", systemUserId);

  const sysMsgCountMap = new Map<string, number>();
  (sysMsgRows ?? []).forEach((r: { conversation_id: string }) => {
    sysMsgCountMap.set(r.conversation_id, (sysMsgCountMap.get(r.conversation_id) ?? 0) + 1);
  });

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

  const allMapped = convs.map((c: { id: string; user1_id: string; user2_id: string; last_message: string | null; last_message_at: string }) => {
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
      user_msg_count: userMsgCountMap.get(c.id) ?? 0,
      sys_msg_count: sysMsgCountMap.get(c.id) ?? 0,
    };
  });

  // 탭별 필터링
  let filtered = allMapped;
  if (tab === "inbox") {
    // 수신함: 유저가 보낸 메시지가 1개 이상인 대화만
    filtered = allMapped.filter((c: { user_msg_count: number }) => c.user_msg_count > 0);
  } else if (tab === "sent") {
    // 발송함: 운영팀 메시지가 있고, 자동 환영 메시지만 있는 대화는 제외
    // → 운영팀 메시지 있음 AND (유저 답장이 있거나 운영팀 메시지가 2개 이상 = 수동 발송이 있음)
    filtered = allMapped.filter((c: { sys_msg_count: number; user_msg_count: number }) =>
      c.sys_msg_count > 0 && (c.user_msg_count > 0 || c.sys_msg_count > 1)
    );
  }

  return NextResponse.json({ conversations: filtered });
}

// POST: 운영팀 계정으로 답장 또는 전체발송
export async function POST(request: NextRequest) {
  if (!checkPin(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const systemUserId = process.env.SYSTEM_USER_ID;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !systemUserId) {
    return NextResponse.json({ error: "missing_config" }, { status: 500 });
  }

  const body = await request.json();
  const admin = getSupabaseAdmin();

  // 전체발송
  if (body.action === "broadcast") {
    const { content, teamIds } = body as { content?: string; teamIds?: number[] };
    if (!content?.trim()) {
      return NextResponse.json({ error: "missing_content" }, { status: 400 });
    }

    // 대상 유저 조회
    let query = admin.from("profiles").select("id, team_id").neq("id", systemUserId);
    if (teamIds && teamIds.length > 0 && teamIds.length < 10) {
      query = query.in("team_id", teamIds);
    }
    const { data: targetUsers, error: userError } = await query;

    if (userError || !targetUsers) {
      return NextResponse.json({ error: "fetch_users_failed" }, { status: 500 });
    }

    let successCount = 0;
    let failCount = 0;

    for (const user of targetUsers) {
      try {
        // 기존 conversation 찾기
        const { data: existingConv } = await admin
          .from("dm_conversations")
          .select("id")
          .or(
            `and(user1_id.eq.${systemUserId},user2_id.eq.${user.id}),and(user1_id.eq.${user.id},user2_id.eq.${systemUserId})`
          )
          .maybeSingle();

        let conversationId: string;

        if (existingConv) {
          conversationId = existingConv.id;
        } else {
          // 새 conversation 생성
          const { data: newConv, error: convError } = await admin
            .from("dm_conversations")
            .insert({
              user1_id: systemUserId,
              user2_id: user.id,
              last_message: content.trim().substring(0, 100),
              last_message_at: new Date().toISOString(),
            })
            .select("id")
            .single();

          if (convError || !newConv) {
            failCount++;
            continue;
          }
          conversationId = newConv.id;
        }

        // 메시지 발송
        const { error: msgError } = await admin
          .from("dm_messages")
          .insert({
            conversation_id: conversationId,
            sender_id: systemUserId,
            content: content.trim(),
          });

        if (msgError) {
          failCount++;
          continue;
        }

        // conversation 업데이트
        await admin
          .from("dm_conversations")
          .update({
            last_message: content.trim().substring(0, 100),
            last_message_at: new Date().toISOString(),
          })
          .eq("id", conversationId);

        successCount++;
      } catch {
        failCount++;
      }
    }

    return NextResponse.json({
      ok: true,
      result: { total: targetUsers.length, success: successCount, fail: failCount },
    });
  }

  // 기존 답장 로직
  const { conversationId, content } = body;
  if (!conversationId || !content?.trim()) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

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
