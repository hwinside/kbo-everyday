import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { sendAdminPush } from "@/lib/admin/push";

/**
 * 유저 → 운영팀 쪽지 발송 직후 클라이언트가 호출하는 어드민 PWA 알림 트리거 (2026-07-18).
 *
 * 쪽지 insert 자체는 클라이언트 supabase-js 직접 insert(useDM.sendMessage)라 서버 훅이
 * 없어서, 발송 성공 후 fire-and-forget으로 이 라우트를 호출한다 (실패해도 쪽지엔 영향 0).
 *
 * 검증(클라 입력 불신):
 * - 인증 유저 + 해당 대화가 운영팀 계정(SYSTEM_USER_ID)과의 대화 + 호출자가 대화 참여자
 * - 미리보기는 클라가 보낸 텍스트가 아니라 DB의 최신 메시지를 service_role로 재조회
 */
export async function POST(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  const systemUserId = process.env.SYSTEM_USER_ID;
  if (!systemUserId) return NextResponse.json({ ok: false });

  const { conversationId } = await req.json();
  if (!conversationId || typeof conversationId !== "string") {
    return NextResponse.json({ error: "conversationId required" }, { status: 400 });
  }

  const userId = verified.user.id;

  const { data: conv } = await supabase
    .from("dm_conversations")
    .select("user1_id,user2_id")
    .eq("id", conversationId)
    .single();

  const isOperatorConv =
    !!conv && (conv.user1_id === systemUserId || conv.user2_id === systemUserId);
  const isParticipant = !!conv && (conv.user1_id === userId || conv.user2_id === userId);
  if (!isOperatorConv || !isParticipant || userId === systemUserId) {
    return NextResponse.json({ ok: false });
  }

  // 최신 메시지 재조회 — 방금 보낸 본인 메시지일 때만 알림 (타인 메시지로 위장 불가)
  const { data: msg } = await supabase
    .from("dm_messages")
    .select("content,image_urls,sender_id")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!msg || msg.sender_id !== userId) return NextResponse.json({ ok: false });

  const { data: profile } = await supabase
    .from("profiles")
    .select("nickname")
    .eq("id", userId)
    .maybeSingle();

  const imageCount = Array.isArray(msg.image_urls) ? msg.image_urls.length : 0;
  const preview = (msg.content || "").trim() || (imageCount > 0 ? "[사진]" : "");
  if (!preview) return NextResponse.json({ ok: false });

  await sendAdminPush({
    title: `새 쪽지 — ${profile?.nickname ?? "유저"}`,
    body: preview.slice(0, 100),
    url: "/admin/messages",
    tag: "admin-dm",
  });

  return NextResponse.json({ ok: true });
}
