// 긴급공지 발송 공용 헬퍼 — 기존 유저 배치(send 스크립트)와 신규 가입 자동발송(welcome-dm)
// 이 두 경로가 동일 로직을 쓰도록 SSOT화. 발신은 항상 URGENT_NOTICE_USER_ID(회신 불가 계정).
import type { SupabaseClient } from "@supabase/supabase-js";
import { URGENT_NOTICE_USER_ID } from "@/lib/constants/urgent-notice";

export interface ActiveNotice {
  notice_key: string;
  message: string;
}

/** platform 대상 active 공지들 (target_platform이 platform 또는 'all') */
export async function getActiveNotices(
  admin: SupabaseClient,
  platform: string,
): Promise<ActiveNotice[]> {
  const { data, error } = await admin
    .from("urgent_notices")
    .select("notice_key, message")
    .eq("active", true)
    .in("target_platform", [platform, "all"]);
  if (error) throw new Error("urgent_notices query: " + error.message);
  return (data ?? []) as ActiveNotice[];
}

async function ensureConversation(admin: SupabaseClient, userId: string): Promise<string> {
  const [u1, u2] = [URGENT_NOTICE_USER_ID, userId].sort();
  const { data: existing } = await admin
    .from("dm_conversations").select("id").eq("user1_id", u1).eq("user2_id", u2).maybeSingle();
  if (existing) return existing.id as string;
  const { data: created, error } = await admin
    .from("dm_conversations").insert({ user1_id: u1, user2_id: u2 }).select("id").single();
  if (error || !created) throw new Error(`conv create ${userId}: ${error?.message}`);
  return created.id as string;
}

/**
 * 한 유저에게 공지 1건 발송 (idempotent — 같은 notice_key가 이미 있으면 skip).
 * dm_messages INSERT → dispatch 웹훅이 📢 푸시. 발신 = 긴급공지 계정.
 */
export async function sendNoticeToUser(
  admin: SupabaseClient,
  userId: string,
  notice: ActiveNotice,
): Promise<"sent" | "skipped"> {
  if (userId === URGENT_NOTICE_USER_ID) return "skipped";
  const convId = await ensureConversation(admin, userId);

  const { data: dup } = await admin
    .from("dm_messages")
    .select("id")
    .eq("conversation_id", convId)
    .eq("sender_id", URGENT_NOTICE_USER_ID)
    .eq("payload->>notice_key", notice.notice_key)
    .limit(1);
  if (dup && dup.length > 0) return "skipped";

  const { error: msgErr } = await admin.from("dm_messages").insert({
    conversation_id: convId,
    sender_id: URGENT_NOTICE_USER_ID,
    content: notice.message,
    payload: { type: "urgent_notice", notice_key: notice.notice_key },
  });
  if (msgErr) throw new Error("msg insert: " + msgErr.message);

  await admin
    .from("dm_conversations")
    .update({ last_message: notice.message.slice(0, 100), last_message_at: new Date().toISOString() })
    .eq("id", convId);
  return "sent";
}
