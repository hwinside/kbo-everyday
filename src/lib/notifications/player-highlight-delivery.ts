import type { TokenDeliveryOutcome } from "@/lib/notifications/fcm-batch";

export type ClaimedHighlightToken = {
  tokenId: number;
  tokenHash: string;
  fcmToken: string;
};

export type HighlightSettlement = {
  token_id: number;
  token_hash: string;
  status: "accepted" | "transient" | "permanent_failed";
  error: string | null;
};

export function shouldProcessHighlightEvent(params: {
  eventAtMs: number;
  nowMs: number;
  freshnessMs: number;
  hasFrozenSnapshot: boolean;
}): boolean {
  return params.hasFrozenSnapshot
    || !Number.isFinite(params.eventAtMs)
    || params.nowMs - params.eventAtMs <= params.freshnessMs;
}

/** FCM의 ok 집계값과 무관하게 token별 결과를 durable 원장 상태로 변환한다. */
export function mapHighlightSettlements(
  claimed: ClaimedHighlightToken[],
  outcomes: TokenDeliveryOutcome[],
  lastError: string | null = null,
): HighlightSettlement[] {
  const outcomeByToken = new Map(outcomes.map((outcome) => [outcome.token, outcome]));
  return claimed.map((row) => {
    const outcome = outcomeByToken.get(row.fcmToken);
    return {
      token_id: row.tokenId,
      token_hash: row.tokenHash,
      status: outcome?.status === "accepted"
        ? "accepted"
        : outcome?.status === "transient" || !outcome
          ? "transient"
          : "permanent_failed",
      error: outcome?.errorCode ?? lastError,
    };
  });
}
