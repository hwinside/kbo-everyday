import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { sendAdminPush } from "@/lib/admin/push";
import { normalizeMessageId } from "@/lib/admin/dm-notify";

/**
 * 유저 → 운영팀 쪽지 발송 직후 클라이언트가 호출하는 어드민 PWA 알림 트리거 (2026-07-18).
 *
 * 쪽지 insert 자체는 클라이언트 supabase-js 직접 insert(useDM.sendMessage)라 서버 훅이
 * 없어서, 발송 성공 후 fire-and-forget으로 이 라우트를 호출한다 (실패해도 쪽지엔 영향 0).
 *
 * 남용 방지 (PR #681 삼순 P1 반영):
 * - messageId를 받아 "정확히 그 행"의 sender/conversation을 service_role로 검증
 * - admin_dm_notify_claims(message_id PK) insert로 메시지당 최초 1회만 발송 —
 *   동시 요청/replay는 PK 충돌(23505)로 탈락 (DB 원자성, tag 치환에 의존하지 않음)
 * - 발신자별 rate limit: 최근 60초 claim 5건 초과 시 발송 skip (claim은 남아 재사용 불가)
 */

const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_PER_WINDOW = 5;

export async function POST(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  const systemUserId = process.env.SYSTEM_USER_ID;
  if (!systemUserId) return NextResponse.json({ ok: false });

  const { conversationId, messageId: rawMessageId } = await req.json();
  // dm_messages.id는 BIGSERIAL(정수) — number 또는 정수 문자열로 정규화
  const messageId = normalizeMessageId(rawMessageId);
  if (!conversationId || typeof conversationId !== "string" || messageId === null) {
    return NextResponse.json({ error: "conversationId, messageId required" }, { status: 400 });
  }

  const userId = verified.user.id;

  // 정확히 해당 메시지 행 검증: 본인이 보낸, 해당 대화의 메시지인가
  const { data: msg } = await supabase
    .from("dm_messages")
    .select("id,conversation_id,sender_id,content,image_urls")
    .eq("id", messageId)
    .maybeSingle();
  if (!msg || msg.conversation_id !== conversationId || msg.sender_id !== userId) {
    return NextResponse.json({ ok: false });
  }

  // 운영팀 대화 + 호출자 참여자 검증
  const { data: conv } = await supabase
    .from("dm_conversations")
    .select("user1_id,user2_id")
    .eq("id", conversationId)
    .maybeSingle();
  const isOperatorConv =
    !!conv && (conv.user1_id === systemUserId || conv.user2_id === systemUserId);
  const isParticipant = !!conv && (conv.user1_id === userId || conv.user2_id === userId);
  if (!isOperatorConv || !isParticipant || userId === systemUserId) {
    return NextResponse.json({ ok: false });
  }

  // 메시지당 1회 claim — PK 충돌이면 이미 발송됨(또는 동시 요청이 선점) → 재발송 금지
  const { error: claimError } = await supabase.from("admin_dm_notify_claims").insert({
    message_id: messageId,
    conversation_id: conversationId,
    sender_id: userId,
  });
  if (claimError) {
    // 23505 unique violation = replay/동시 요청, 그 외 DB 오류도 발송하지 않음 (fail closed)
    return NextResponse.json({ ok: false, duplicate: claimError.code === "23505" });
  }

  // 발신자별 rate limit — 초과 시 발송만 skip (claim은 기록돼 해당 메시지는 소진됨)
  const windowStart = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const { count, error: rateError } = await supabase
    .from("admin_dm_notify_claims")
    .select("*", { count: "exact", head: true })
    .eq("sender_id", userId)
    .gte("created_at", windowStart);
  if (rateError || (count ?? 0) > RATE_MAX_PER_WINDOW) {
    return NextResponse.json({ ok: false, rateLimited: true });
  }

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
