import type { SupabaseClient } from "@supabase/supabase-js";
import { sendOpsMessageToUser } from "@/lib/cs/send-ops-message";

/** 서로 다른 신고자 수가 이 값 이상이면 자동 블라인드 대상이 된다. */
export const REPORT_BLIND_THRESHOLD = 3;

export type ReportTargetType = "post" | "comment" | "chat";

/** 안내 쪽지에 들어갈 대상 유형 한글 라벨. */
export function blindTargetLabel(targetType: string): string {
  switch (targetType) {
    case "chat":
      return "채팅 메시지";
    case "post":
      return "게시글";
    case "comment":
      return "댓글";
    default:
      return "게시물";
  }
}

/** 블라인드 처리 안내 쪽지 문안(하린아빠 승인 문안, 대상 라벨만 치환). */
export function buildBlindNotice(label: string): string {
  return [
    "안녕하세요, 크보팬 운영팀입니다.",
    `회원님이 작성하신 ${label}이(가) 여러 이용자의 신고를 받아, 커뮤니티 운영정책(욕설·비방·인신공격 금지)에 따라 블라인드 처리되었음을 안내드립니다.`,
    "크보팬은 모든 팬이 존중받으며 응원할 수 있는 공간을 지향합니다.",
    "반복될 경우 채팅 이용이 제한될 수 있습니다. 건강한 응원 문화에 협조 부탁드립니다.",
  ].join("\n");
}

export type BlindResult = {
  /** 이번 요청이 실제 블라인드 전환을 수행했는지(멱등 가드 통과). */
  blinded: boolean;
  /** 작성자에게 안내 쪽지 발송에 성공했는지. */
  notified: boolean;
  reason?: string;
};

function isSupportedType(t: string): t is ReportTargetType {
  return t === "post" || t === "comment" || t === "chat";
}

/**
 * 신고 접수 직후 호출 — 서로 다른 신고자 수가 임계값에 도달하면 대상을
 * 자동 블라인드하고 작성자에게 안내 쪽지를 1회 발송한다.
 *
 * 멱등/동시성:
 *  - 신고자 수는 reports 행 수로 판정(UNIQUE(reporter_id,target_type,target_id)
 *    제약으로 행 수 = 서로 다른 신고자 수).
 *  - 블라인드 전환은 원자적 가드(chat: deleted_at IS NULL / post·comment:
 *    is_hidden=false)로 수행 → 동시에 임계값을 넘긴 여러 요청 중 정확히 하나만
 *    전환에 성공(RETURNING 1행)하고, 그 요청만 쪽지를 보낸다(중복 발송 없음).
 *  - 쪽지 발송 실패는 블라인드 결과에 영향을 주지 않는다(fail-safe). 신고 접수
 *    자체의 성공/실패와도 분리된다(호출부에서 try/catch).
 */
export async function maybeBlindAndNotify(
  admin: SupabaseClient,
  systemUserId: string,
  targetType: string,
  targetId: number,
): Promise<BlindResult> {
  if (!isSupportedType(targetType)) {
    return { blinded: false, notified: false, reason: "unsupported_type" };
  }

  // 1) 서로 다른 신고자 수
  const { count, error: countErr } = await admin
    .from("reports")
    .select("reporter_id", { count: "exact", head: true })
    .eq("target_type", targetType)
    .eq("target_id", targetId);
  if (countErr) {
    return { blinded: false, notified: false, reason: "count_failed" };
  }
  if ((count ?? 0) < REPORT_BLIND_THRESHOLD) {
    return { blinded: false, notified: false, reason: "below_threshold" };
  }

  // 2) 원자적 블라인드 전환 → 전환에 성공한 경우에만 작성자 id 확보
  let authorId: string | null = null;
  if (targetType === "chat") {
    const { data } = await admin
      .from("chat_messages")
      .update({
        content: "삭제된 메시지입니다",
        deleted_at: new Date().toISOString(),
        deleted_by: systemUserId,
      })
      .eq("id", targetId)
      .is("deleted_at", null)
      .select("user_id");
    if (data && data.length === 1) {
      authorId = (data[0] as { user_id: string | null }).user_id;
    }
  } else {
    const table = targetType === "post" ? "posts" : "comments";
    const { data } = await admin
      .from(table)
      .update({ is_hidden: true })
      .eq("id", targetId)
      .eq("is_hidden", false)
      .select("author_id");
    if (data && data.length === 1) {
      authorId = (data[0] as { author_id: string | null }).author_id;
    }
  }

  if (!authorId) {
    // 이미 블라인드된 상태(다른 요청이 먼저 전환) → 중복 처리 없음
    return { blinded: false, notified: false, reason: "already_blinded" };
  }
  // 운영자/시스템 계정 글은 안내 대상 아님
  if (authorId === systemUserId) {
    return { blinded: true, notified: false, reason: "author_is_system" };
  }

  // 3) 작성자에게 안내 쪽지 1회 (fail-safe)
  const notice = buildBlindNotice(blindTargetLabel(targetType));
  const sent = await sendOpsMessageToUser(admin, systemUserId, authorId, notice);
  return {
    blinded: true,
    notified: sent.ok,
    reason: sent.ok ? undefined : `notify_failed:${sent.reason}`,
  };
}
