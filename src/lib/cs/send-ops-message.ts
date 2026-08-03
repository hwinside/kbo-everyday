import type { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isDeepStrictEqual } from "node:util";

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
  expectedPayload: object | null,
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
    .select("id, payload")
    .eq("dedup_key", dedupKey)
    .eq("sender_id", systemUserId)
    .eq("conversation_id", conversation.id)
    .eq("content", expectedContent)
    .maybeSingle();
  if (msgError) return { ok: false, reason: "dedup_message_lookup_failed" };
  if (!message) return { ok: true, found: false };
  const actualPayload = (message as { payload?: unknown }).payload ?? null;
  if (!isDeepStrictEqual(actualPayload, expectedPayload)) return { ok: true, found: false };
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
  /**
   * dm_messages.payload 에 함께 저장할 구조화 데이터 (야잘알봇 답변 유형 등).
   * 생략하면 NULL — 기존 발송 경로(CS 회신·broadcast·blind-notify)는 무변경이다.
   */
  payload?: object | null,
): Promise<SendOpsResult> {
  const text = content.replace(/\r\n/g, "\n").trimEnd();
  if (!text.trim()) return { ok: false, reason: "empty_content" };
  const preview = text.trim().replace(/\s+/g, " ").substring(0, 100);

  // 대화 upsert + 메시지 INSERT + preview/origin 확정을 service_role 전용 RPC 한
  // 트랜잭션으로 묶는다. 실패 시 전부 rollback → 빈 대화·숨은 대화가 남지
  // 않고, 호출부는 error 를 받아 CS 원클릭 회신을 resolved 처리하지 않는다.
  // query-guard: bounded -- admin_send_ops_message 는 항상 정확히 1행(conversation_id) 반환.
  const { data, error } = await admin.rpc("admin_send_ops_message", {
    p_system_user_id: systemUserId,
    p_user_id: userId,
    p_content: text,
    p_preview: preview,
    p_origin: origin === "feedback" ? "feedback" : "dm",
    p_dedup_key: dedupKey ?? null,
    p_payload: payload ?? null,
  });

  if (error) {
    // dedup_key 가 다른 대화/발신자와 충돌(위조 의심)이면 RPC 가 23505 로 rollback.
    if (dedupKey && error.code === "23505") {
      // belt-and-suspenders: 같은 대화·운영팀 발신으로 이미 있으면 멱등 성공으로 간주.
      const verified = await verifyOpsMessageByDedupKey(
        admin,
        systemUserId,
        userId,
        dedupKey,
        text,
        payload ?? null,
      );
      if (verified.ok && verified.found) {
        return { ok: true, conversationId: verified.conversationId };
      }
      return { ok: false, reason: verified.ok ? "dedup_key_conflict_foreign" : verified.reason };
    }
    return { ok: false, reason: "send_failed" };
  }

  const row = Array.isArray(data) ? data[0] : data;
  const conversationId = row?.conversation_id as string | undefined;
  if (!conversationId) return { ok: false, reason: "send_failed" };
  return { ok: true, conversationId };
}
