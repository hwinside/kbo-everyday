import type { TokenDeliveryOutcome } from "@/lib/notifications/fcm-batch";
import { runBeforeDeadline } from "@/lib/async-deadline";

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

export async function drainDueHighlightSnapshots<T>(params: {
  snapshots: T[];
  needsAudience: (snapshot: T) => boolean;
  fetchAudience: (snapshot: T, deadlineAtMs: number) => Promise<string[]>;
  drain: (snapshot: T, userIds: string[]) => Promise<number>;
  deadlineAtMs?: number;
  audienceTimeoutMs?: number;
}): Promise<number> {
  let accepted = 0;
  for (const snapshot of params.snapshots) {
    if (params.deadlineAtMs != null && Date.now() >= params.deadlineAtMs) break;

    let userIds: string[] = [];
    if (params.needsAudience(snapshot)) {
      const audienceDeadlineAtMs = Math.min(
        params.deadlineAtMs ?? Number.POSITIVE_INFINITY,
        Date.now() + (params.audienceTimeoutMs ?? 3_000),
      );
      try {
        userIds = await runBeforeDeadline(
          () => params.fetchAudience(snapshot, audienceDeadlineAtMs),
          audienceDeadlineAtMs,
        );
      } catch {
        continue;
      }
    }
    accepted += await params.drain(snapshot, userIds);
  }
  return accepted;
}

export async function persistHighlightSnapshotBeforeAudience<T>(params: {
  snapshot: T;
  persist: (snapshot: T, signal: AbortSignal) => PromiseLike<void>;
  deadlineAtMs?: number;
  timeoutMs?: number;
}): Promise<boolean> {
  const persistenceDeadlineAtMs = Math.min(
    params.deadlineAtMs ?? Number.POSITIVE_INFINITY,
    Date.now() + (params.timeoutMs ?? 3_000),
  );
  const controller = new AbortController();
  const abortTimer = setTimeout(
    () => controller.abort(),
    Math.max(0, persistenceDeadlineAtMs - Date.now()),
  );
  try {
    await runBeforeDeadline(
      () => params.persist(params.snapshot, controller.signal),
      persistenceDeadlineAtMs,
    );
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(abortTimer);
  }
}
