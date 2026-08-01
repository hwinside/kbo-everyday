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
const WEBHOOK_TIMEOUT_MS = 5_000;

export interface PendingMove {
  playerName: string;
  teamId: number;
  moveDate: string;
  /** 미충족 readiness 체크 (roster/photo/hero/live-page). */
  missing: string[];
}

const MISSING_LABEL: Record<string, string> = {
  roster: "로스터 SSOT",
  photo: "프로필 사진(매핑)",
  hero: "히어로컷(allowlist)",
  "profile-asset": "프로필 JPG(prod 실측)",
  "hero-asset": "히어로 WEBP(prod 실측)",
  "player-page": "선수 상세(서버 신호)",
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

/** published 등록 링크 불변식 위반(fail-closed) 항목 — 조회 시 사용자 미노출 + 운영 알림용. */
export interface RegisterAnomaly {
  playerName: string;
  teamId: number;
  moveDate: string;
  kboPlayerId: string;
  /** 저장된 canonical_id(없거나 resolve 불일치라 href를 만들 수 없었던 값). */
  canonicalId: string | null;
}

/**
 * published 등록 링크 불변식 위반 운영 알림 (삼순 P0 3차 — fail-closed 표면화).
 * status='published' 등록인데 저장된 canonical_id가 없거나(미저장) resolve 불일치라 클릭 가능한
 * href를 만들 수 없는 row는 사용자에게 렌더하지 않고(API 미반환) 이 알림으로 운영에 표면화한다.
 * throw 없이 status만 반환한다(알림 실패가 API 응답을 가리지 않도록).
 */
export async function notifyRegisterAnomaly(
  anomalies: RegisterAnomaly[],
): Promise<{ status: PendingNotifyStatus }> {
  if (anomalies.length === 0) return { status: "no-pending" };
  if (!WEBHOOK_URL) return { status: "no-webhook" };
  const lines = anomalies
    .map((a) => {
      const team = getTeamById(a.teamId)?.shortName ?? String(a.teamId);
      return `• ${a.playerName} (${team}, ${a.moveDate} 등록) — kboPlayerId=${a.kboPlayerId}, canonical=${a.canonicalId ?? "null"}`;
    })
    .join("\n");
  const text =
    `🚨 *published 등록 링크 불변식 위반 ${anomalies.length}건* — 저장된 canonical id가 없거나 resolve 불일치라 ` +
    `클릭 가능한 링크를 만들 수 없어 사용자 노출을 차단(fail-closed)했습니다.\n` +
    `${lines}\n_승격(publish) 로직/roster SSOT 확인 필요 — 링크 없는 published 등록은 계약 위반._`;
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return { status: res.ok ? "sent" : "webhook-error" };
  } catch {
    return { status: "webhook-error" };
  }
}

/**
 * KBO 수집 실패 운영 알림(삼순 P1 — silent success 제거). 기존 ROSTER_GAP_SLACK_WEBHOOK 재사용.
 * throw 없이 status만 반환한다(알림 실패가 cron 5xx 결정을 가리지 않도록).
 */
export async function notifyCollectionFailure(
  reason: string,
): Promise<{ status: PendingNotifyStatus }> {
  if (!WEBHOOK_URL) return { status: "no-webhook" };
  const text =
    `🚨 *로스터 변동 수집 실패* — KBO 등록명단 수집이 실패해 이번 회차 스냅샷을 갱신하지 않았습니다(기존 스냅샷 불변).\n` +
    `사유: ${reason}\n_KBO 403/마크업 변경 가능성 — 확인 필요._`;
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    return { status: res.ok ? "sent" : "webhook-error" };
  } catch {
    return { status: "webhook-error" };
  }
}

/**
 * pending 통보. webhook 미설정/pending 없음/전송 실패 모두 throw 없이 status 반환
 * (cron 본작업을 절대 막지 않도록 — 알림은 부가 기능).
 */
export async function notifyPendingMoves(
  pending: PendingMove[],
  opts: { deadlineAtMs?: number } = {},
): Promise<{ status: PendingNotifyStatus }> {
  if (pending.length === 0) return { status: "no-pending" };
  if (!WEBHOOK_URL) return { status: "no-webhook" };
  const remainingMs = opts.deadlineAtMs == null
    ? WEBHOOK_TIMEOUT_MS
    : Math.min(WEBHOOK_TIMEOUT_MS, opts.deadlineAtMs - Date.now());
  if (remainingMs <= 0) return { status: "webhook-error" };
  const settleReserveMs = opts.deadlineAtMs == null
    ? 0
    : Math.min(25, Math.max(1, Math.floor(remainingMs / 10)));
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: formatPendingMessage(pending) }),
      signal: AbortSignal.timeout(Math.max(1, remainingMs - settleReserveMs)),
    });
    return { status: res.ok ? "sent" : "webhook-error" };
  } catch {
    return { status: "webhook-error" };
  }
}
