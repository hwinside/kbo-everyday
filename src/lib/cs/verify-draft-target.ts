import type { getSupabaseAdmin } from "@/lib/supabase/admin";

type SupabaseAdmin = ReturnType<typeof getSupabaseAdmin>;

/**
 * kind/userId가 실제 원본 CS 건(feedback 소유자 또는 dm 대화 참여자)과 일치하는지 검증한다.
 * draft 생성 시점과 발송 직전(POST) 양쪽에서 재사용 — 잘못된 payload로
 * "A 유저에게 발송 + B feedback resolved" 상태가 생기는 걸 API 레벨에서 막는다.
 */
export async function verifyDraftTarget(
  admin: SupabaseAdmin,
  kind: "feedback" | "dm",
  userId: string,
  conversationId: string | null,
  feedbackId: string | null,
  systemUserId: string,
): Promise<boolean> {
  if (kind === "feedback") {
    if (feedbackId == null) return false;
    const { data } = await admin
      .from("feedback")
      .select("user_id")
      .eq("id", feedbackId)
      .maybeSingle();
    return !!data && data.user_id === userId;
  }

  if (kind === "dm") {
    if (!conversationId) return false;
    const { data } = await admin
      .from("dm_conversations")
      .select("user1_id, user2_id")
      .eq("id", conversationId)
      .maybeSingle();
    if (!data) return false;
    const participants = [data.user1_id, data.user2_id];
    return participants.includes(systemUserId) && participants.includes(userId);
  }

  return false;
}
