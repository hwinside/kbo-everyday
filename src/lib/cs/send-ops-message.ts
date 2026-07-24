import type { getSupabaseAdmin } from "@/lib/supabase/admin";

type SupabaseAdmin = ReturnType<typeof getSupabaseAdmin>;

export type SendOpsResult =
  | { ok: true; conversationId: string }
  | { ok: false; reason: string };

export type VerifyOpsDedupResult =
  | { ok: true; found: true; conversationId: string }
  | { ok: true; found: false }
  | { ok: false; reason: string };

/**
 * dedup_key 가 실제 운영팀→대상 유저 대화에 같은 내용으로 존재하는지 검증한다.
 * exhausted outbox 재진입과 23505 멱등 확인이 같은 production helper 를 공유한다.
 */
export async function verifyOpsMessageByDedupKey(
  admin: SupabaseAdmin,
  systemUserId: string,
  userId: string,
  dedupKey: string,
  expectedContent: string,
): Promise<VerifyOpsDedupResult> {
  const [u1, u2] = [systemUserId, userId].sort();
  const { data: conversation, error: convError } = await admin
    .from("dm_conversations")
    .select("id")
    .eq("user1_id", u1)
    .eq("user2_id", u2)
    .maybeSingle();
  if (convError) return { ok: false, reason: "dedup_conversation_lookup_failed" };
  if (!conversation) return { ok: true, found: false };

  const { data: message, error: msgError } = await admin
    .from("dm_messages")
    .select("id")
    .eq("dedup_key", dedupKey)
    .eq("sender_id", systemUserId)
    .eq("conversation_id", conversation.id)
    .eq("content", expectedContent)
    .maybeSingle();
  if (msgError) return { ok: false, reason: "dedup_message_lookup_failed" };
  if (!message) return { ok: true, found: false };
  return { ok: true, found: true, conversationId: conversation.id };
}

/**
 * 운영팀 계정으로 유저에게 쪽지를 발송한다.
 * admin/messages 의 send_to_user 경로와 동일 로직(대화 upsert → 메시지 insert → last_message 갱신).
 * CS 원클릭 회신(/api/cs/approve)에서 재사용한다.
 *
 * origin='feedback' 지정 시 대화를 피드백 회신 대화로 마킹한다.
 * → admin_dm_inbox_page RPC 가 유저 발신이 없어도 이 대화를 운영팀 수신함에 노출한다.
 * (건의함 회신처럼 운영팀 발신만 존재하는 대화가 수신함에서 빠지던 문제 해결)
 */
export async function sendOpsMessageToUser(
  admin: SupabaseAdmin,
  systemUserId: string,
  userId: string,
  content: string,
  dedupKey?: string,
  origin?: "dm" | "feedback",
): Promise<SendOpsResult> {
  const text = content.replace(/\r\n/g, "\n").trimEnd();
  if (!text.trim()) return { ok: false, reason: "empty_content" };
  const preview = text.trim().replace(/\s+/g, " ").substring(0, 100);

  const [u1, u2] = [systemUserId, userId].sort();

  const { data: existing } = await admin
    .from("dm_conversations")
    .select("id")
    .eq("user1_id", u1)
    .eq("user2_id", u2)
    .maybeSingle();

  let conversationId: string;
  if (existing) {
    conversationId = existing.id;
  } else {
    const { data: created, error: convError } = await admin
      .from("dm_conversations")
      .insert({
        user1_id: u1,
        user2_id: u2,
        ...(origin === "feedback" ? { origin: "feedback" } : {}),
      })
      .select("id")
      .single();
    if (convError || !created) return { ok: false, reason: "conv_create_failed" };
    conversationId = created.id;
  }

  const messageRow: Record<string, unknown> = {
    conversation_id: conversationId,
    sender_id: systemUserId,
    content: text,
  };
  // dedupKey 지정 시 dm_messages.dedup_key 로 멱등 발송(같은 키 재발송 = UNIQUE 위반 → 이미 발송됨).
  if (dedupKey) messageRow.dedup_key = dedupKey;

  const { error: msgError } = await admin.from("dm_messages").insert(messageRow);
  if (msgError) {
    // 멱등: 같은 dedup_key 로 이미 발송된 건이면 성공으로 간주(발송 성공 후 crash → 재발송 방지).
    // ⚠️ dedup_key 는 DB 트리거(guard_dm_message_dedup_key)로 service role 만 세팅 가능해
    //    일반 유저 선점 위조가 불가하지만, belt-and-suspenders 로 기존 행이 진짜 운영팀
    //    발신이고 같은 대화방·내용인지 검증한 후에만 성공 처리한다.
    if (dedupKey && msgError.code === "23505") {
      const verified = await verifyOpsMessageByDedupKey(
        admin,
        systemUserId,
        userId,
        dedupKey,
        text,
      );
      if (verified.ok && verified.found && verified.conversationId === conversationId) {
        return { ok: true, conversationId: verified.conversationId };
      }
      // 기존 행이 운영팀 발신이 아니면(이론상 불가) 위조 의심 → 실패로 처리해 재시도/관제.
      return {
        ok: false,
        reason: verified.ok ? "dedup_key_conflict_foreign" : verified.reason,
      };
    }
    return { ok: false, reason: "send_failed" };
  }

  await admin
    .from("dm_conversations")
    .update({
      last_message: preview,
      last_message_at: new Date().toISOString(),
      // 기존 대화(broadcast 등)에 피드백 회신 시에도 수신함 노출을 위해 origin 마킹.
      ...(origin === "feedback" ? { origin: "feedback" } : {}),
    })
    .eq("id", conversationId);

  return { ok: true, conversationId };
}
