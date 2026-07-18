/**
 * 로스터 변동 pending 알림 — 등록 감지됐지만 에셋 미준비로 공개 대기(pending) 중인
 * 선수를 슬랙으로 통보한다 (삼순 P0: 공개 게이트 실패의 silent omission 금지).
 *
 * 기존 로스터 갭 알림(src/lib/game-logs/roster-gap-alert.ts)과 동일 패턴/동일 env 재사용:
 * 활성화: env ROSTER_GAP_SLACK_WEBHOOK (Slack Incoming Webhook URL).
 * 미설정 시 no-op (pending 목록은 cron 응답 JSON에 항상 포함되므로 추적 가능).
 */

import { getTeamById } from "@/lib/constants/teams";

const WEBHOOK_URL = process.env.ROSTER_GAP_SLACK_WEBHOOK || "";

export interface PendingMove {
  playerName: string;
  teamId: number;
  moveDate: string;
  /** 미충족 readiness 체크 (roster/photo/hero/live-page). */
  missing: string[];
}

const MISSING_LABEL: Record<string, string> = {
  roster: "로스터 SSOT",
  photo: "프로필 사진",
  hero: "히어로컷",
  "live-page": "선수 상세 페이지",
};

export function formatPendingMessage(pending: PendingMove[]): string {
  const lines = pending
    .map((p) => {
      const team = getTeamById(p.teamId)?.shortName ?? String(p.teamId);
      const missing = p.missing.map((m) => MISSING_LABEL[m] ?? m).join(", ");
      return `• ${p.playerName} (${team}, ${p.moveDate} 등록) — 대기 사유: ${missing}`;
    })
    .join("\n");
  const needsForeignMap = pending.some((p) => p.missing.includes("roster"));
  return (
    `⏳ *로스터 등록 공개 대기(pending) ${pending.length}건* — 에셋 준비 완료 전까지 미노출\n` +
    `${lines}\n` +
    `_새벽 reconcile(roster) → update-player-photos(사진) → hero 배치(히어로컷) 순으로 자동 준비됩니다._` +
    (needsForeignMap
      ? `\n_⚠️ 로스터 SSOT 미매칭 건은 신규 외국인일 수 있습니다 — foreign-id-map 수동 등록 필요._`
      : "")
  );
}

export type PendingNotifyStatus = "no-pending" | "no-webhook" | "sent" | "webhook-error";

/**
 * pending 통보. webhook 미설정/pending 없음/전송 실패 모두 throw 없이 status 반환
 * (cron 본작업을 절대 막지 않도록 — 알림은 부가 기능).
 */
export async function notifyPendingMoves(
  pending: PendingMove[],
): Promise<{ status: PendingNotifyStatus }> {
  if (pending.length === 0) return { status: "no-pending" };
  if (!WEBHOOK_URL) return { status: "no-webhook" };
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: formatPendingMessage(pending) }),
    });
    return { status: res.ok ? "sent" : "webhook-error" };
  } catch {
    return { status: "webhook-error" };
  }
}
