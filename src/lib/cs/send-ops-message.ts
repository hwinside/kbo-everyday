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
  dedupKey?: string,
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
    //    발신(sender=systemUserId)이고 같은 대화방인지 검증한 후에만 성공 처리한다.
    if (dedupKey && msgError.code === "23505") {
      const { data: dup } = await admin
        .from("dm_messages")
        .select("sender_id, conversation_id")
        .eq("dedup_key", dedupKey)
        .maybeSingle();
      if (dup && dup.sender_id === systemUserId && dup.conversation_id === conversationId) {
        return { ok: true, conversationId };
      }
      // 기존 행이 운영팀 발신이 아니면(이론상 불가) 위조 의심 → 실패로 처리해 재시도/관제.
      return { ok: false, reason: "dedup_key_conflict_foreign" };
    }
    return { ok: false, reason: "send_failed" };
  }

  await admin
    .from("dm_conversations")
    .update({ last_message: preview, last_message_at: new Date().toISOString() })
    .eq("id", conversationId);

  return { ok: true, conversationId };
}
