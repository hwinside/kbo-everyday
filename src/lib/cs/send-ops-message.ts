import type { getSupabaseAdmin } from "@/lib/supabase/admin";

type SupabaseAdmin = ReturnType<typeof getSupabaseAdmin>;

export type SendOpsResult =
  | { ok: true; conversationId: string }
  | { ok: false; reason: string };

/**
 * 운영팀 계정으로 유저에게 쪽지를 발송한다.
 * admin/messages 의 send_to_user 경로와 동일 로직(대화 upsert → 메시지 insert → last_message 갱신).
 * CS 원클릭 회신(/api/cs/approve)에서 재사용한다.
 */
export async function sendOpsMessageToUser(
  admin: SupabaseAdmin,
  systemUserId: string,
  userId: string,
  content: string,
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
      .insert({ user1_id: u1, user2_id: u2 })
      .select("id")
      .single();
    if (convError || !created) return { ok: false, reason: "conv_create_failed" };
    conversationId = created.id;
  }

  const { error: msgError } = await admin
    .from("dm_messages")
    .insert({ conversation_id: conversationId, sender_id: systemUserId, content: text });
  if (msgError) return { ok: false, reason: "send_failed" };

  await admin
    .from("dm_conversations")
    .update({ last_message: preview, last_message_at: new Date().toISOString() })
    .eq("id", conversationId);

  return { ok: true, conversationId };
}
