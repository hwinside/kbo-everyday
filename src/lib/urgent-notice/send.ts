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

export type SendNoticeResult = "sent" | "skipped" | "inactive" | "platform_skip";

/**
 * 한 유저에게 공지 1건 발송 (원자적 멱등 + SSOT).
 * DB RPC send_urgent_notice — 인자는 notice_key,user_id,platform만(sender·문안은 DB SSOT에서
 * 읽음, 삼순 P0 위조 차단). RPC가 active/target 게이트 + (notice_key,user_id) unique claim +
 * dm insert + conv 갱신을 한 트랜잭션으로 처리(삼순 #2). 오류는 throw(fail-closed).
 * dm_messages INSERT → dispatch 웹훅이 📢 푸시. 발신 = 긴급공지 계정(RPC 내부 SSOT).
 * @param platform 대상 유저 플랫폼(서버 검증값). notice target과 불일치 시 RPC가 platform_skip.
 */
export async function sendNoticeToUser(
  admin: SupabaseClient,
  userId: string,
  notice: ActiveNotice,
  platform?: string,
): Promise<SendNoticeResult> {
  if (userId === URGENT_NOTICE_USER_ID) return "skipped";
  const { data, error } = await admin.rpc("send_urgent_notice", {
    p_notice_key: notice.notice_key,
    p_user_id: userId,
    p_platform: platform ?? null,
  });
  if (error) throw new Error("send_urgent_notice rpc: " + error.message);
  return (data as SendNoticeResult) ?? "skipped";
}
