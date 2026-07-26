import { randomUUID } from "node:crypto";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { sendFcmToTokens, type PushPayload } from "@/lib/notifications/fcm";
import {
  drainGameStartDeliveryBatches,
  gameStartDeliveryWindow,
} from "@/lib/notifications/game-start-delivery-policy";

const SNAPSHOT_DEADLINE_MS = 90_000;
export const START_DELIVERY_TRANSPORT_MS = 8_000;
export const START_DELIVERY_ATTEMPT_MS = 14_000;
const START_DELIVERY_SETTLE_RESERVE_MS = 4_000;
const START_DELIVERY_LEASE_SECONDS = 45;

type ClaimedDelivery = {
  id: string;
  token_id: number;
  token_hash: string;
  platform: "ios" | "android";
  fcm_token: string;
  deadline_at: string;
};

export type GameStartDeliveryResult = {
  snapshotCompleted: boolean;
  /** 이번 invocation에서 fencing을 통과해 accepted로 새로 전이한 수. */
  fcmAcceptedDelta: number;
  /** snapshot 전체의 accepted 누계. */
  fcmAcceptedTotal: number;
  /** device ACK writer 도입 전에는 미계측(null). */
  deviceDelivered: number | null;
  pending: number;
  permanentFailed: number;
  expired: number;
};

export type GameStartDeliveryBatchResult = GameStartDeliveryResult & {
  claimed: number;
};

export type GameStartDeliveryTarget = {
  gameId: string;
  teamIds: number[];
  observedAtMs: number;
  payload: PushPayload;
};

function remainingMs(deadlineAtMs: number | undefined, operation: string): number | null {
  if (deadlineAtMs == null) return null;
  const remaining = deadlineAtMs - Date.now();
  if (remaining <= 0) throw new Error(`${operation}: deadline_exceeded`);
  return remaining;
}

const EMPTY: GameStartDeliveryResult = {
  snapshotCompleted: false,
  fcmAcceptedDelta: 0,
  fcmAcceptedTotal: 0,
  deviceDelivered: null,
  pending: 0,
  permanentFailed: 0,
  expired: 0,
};

export async function finalizeGameStartSnapshot(
  gameId: string,
  fcmAcceptedDelta = 0,
  requestDeadlineAtMs?: number,
): Promise<GameStartDeliveryResult> {
  const remaining = remainingMs(requestDeadlineAtMs, "start delivery finalize");
  // query-guard: bounded -- 단일 game_id 집계 결과를 정확히 1행 반환한다.
  let query = supabase.rpc("finalize_game_start_deliveries", {
    p_game_id: gameId,
  });
  if (remaining != null) query = query.abortSignal(AbortSignal.timeout(remaining));
  const { data, error } = await query;
  if (error) throw new Error(`start delivery finalize: ${error.message}`);
  const row = (data?.[0] ?? null) as {
    snapshot_completed?: boolean;
    accepted?: number;
    device_delivered?: number;
    pending?: number;
    permanent_failed?: number;
    expired?: number;
  } | null;
  if (!row) return { ...EMPTY, fcmAcceptedDelta };
  return {
    snapshotCompleted: Boolean(row.snapshot_completed),
    fcmAcceptedDelta,
    fcmAcceptedTotal: Number(row.accepted ?? 0),
    deviceDelivered: row.device_delivered == null ? null : Number(row.device_delivered),
    pending: Number(row.pending ?? 0),
    permanentFailed: Number(row.permanent_failed ?? 0),
    expired: Number(row.expired ?? 0),
  };
}

/** 모든 대상 경기의 snapshot을 발송 시작 전에 먼저 열 수 있도록 생성과 drain을 분리한다. */
export async function openGameStartSnapshot(
  args: GameStartDeliveryTarget & { requestDeadlineAtMs?: number },
): Promise<number> {
  const remaining = remainingMs(args.requestDeadlineAtMs, "start delivery snapshot");
  const proposedDeadlineAtMs = args.observedAtMs + SNAPSHOT_DEADLINE_MS;
  // query-guard: bounded -- 단일 game snapshot의 persisted deadline scalar 1개만 반환한다.
  let query = supabase.rpc("snapshot_game_start_deliveries", {
    p_game_id: args.gameId,
    p_team_ids: args.teamIds,
    p_snapshot_at: new Date(args.observedAtMs).toISOString(),
    p_deadline_at: new Date(proposedDeadlineAtMs).toISOString(),
  });
  if (remaining != null) query = query.abortSignal(AbortSignal.timeout(remaining));
  const { data: snapshotDeadline, error: snapshotError } = await query;
  if (snapshotError) throw new Error(`start delivery snapshot: ${snapshotError.message}`);
  const deadlineAtMs = Date.parse(String(snapshotDeadline ?? ""));
  if (!Number.isFinite(deadlineAtMs)) throw new Error("start delivery snapshot: invalid persisted deadline");
  return deadlineAtMs;
}

/** 한 게임에서 최대 500행 한 batch만 처리한다. 호출부가 게임별 round-robin을 담당한다. */
export async function deliverGameStartBatch(args: GameStartDeliveryTarget & {
  snapshotDeadlineAtMs: number;
  attemptDeadlineAtMs: number;
}): Promise<GameStartDeliveryBatchResult> {
  const attemptDeadlineAtMs = Math.min(args.snapshotDeadlineAtMs, args.attemptDeadlineAtMs);
  if (Date.now() >= attemptDeadlineAtMs) {
    return { ...EMPTY, claimed: 0 };
  }

  const leaseToken = randomUUID();
  // transport는 8초 이내로 bound하고 lease는 20초로 감싸 중첩 send를 막되,
  // worker crash 뒤 다음 1분 cron이 최초 90초 deadline 안에서 재claim할 수 있게 한다.
  // query-guard: bounded -- SQL RPC가 p_limit을 최대 500행으로 clamp한다.
  const claimRemainingMs = remainingMs(attemptDeadlineAtMs, "start delivery claim")!;
  const claimQuery = supabase.rpc("claim_game_start_deliveries", {
    p_game_id: args.gameId,
    p_lease_token: leaseToken,
    p_lease_seconds: START_DELIVERY_LEASE_SECONDS,
    p_limit: 500,
  }).abortSignal(AbortSignal.timeout(claimRemainingMs));
  const { data, error: claimError } = await claimQuery;
  if (claimError) throw new Error(`start delivery claim: ${claimError.message}`);
  const claimed = (data ?? []) as ClaimedDelivery[];
  if (claimed.length === 0) {
    return {
      ...(await finalizeGameStartSnapshot(args.gameId, 0, attemptDeadlineAtMs)),
      claimed: 0,
    };
  }

  const window = gameStartDeliveryWindow(
    args.snapshotDeadlineAtMs,
    Date.now(),
    Math.min(
      attemptDeadlineAtMs - START_DELIVERY_SETTLE_RESERVE_MS,
      Date.now() + START_DELIVERY_TRANSPORT_MS,
    ),
  );
  if (!window) {
    return {
      ...(await finalizeGameStartSnapshot(args.gameId, 0, attemptDeadlineAtMs)),
      claimed: claimed.length,
    };
  }
  // 외부 FCM 부작용 직전 durable intent. 성공한 행은 snapshot deadline까지 재claim하지
  // 않는 at-most-once 정책이라, accepted 직후 worker crash/settle stall도 중복 발송 0이다.
  // claim 직후 이 RPC 전 crash는 dispatch_started_at=null이라 다음 cron이 재claim한다.
  const dispatchRemainingMs = attemptDeadlineAtMs - Date.now();
  if (dispatchRemainingMs <= 0) throw new Error("start delivery dispatch intent: deadline_exceeded");
  const dispatchQuery = supabase.rpc("mark_game_start_deliveries_dispatching", {
    p_ids: claimed.map((row) => row.id),
    p_lease_token: leaseToken,
  }).abortSignal(AbortSignal.timeout(Math.max(1, dispatchRemainingMs)));
  const { data: dispatching, error: dispatchError } = await dispatchQuery;
  if (dispatchError) throw new Error(`start delivery dispatch intent: ${dispatchError.message}`);
  if (Number(dispatching ?? 0) !== claimed.length) {
    throw new Error("start delivery dispatch intent: fencing mismatch");
  }
  const delivery = await sendFcmToTokens(
    claimed.map((row) => row.fcm_token),
    {
      ...args.payload,
      collapseKey: `game_start_${args.gameId}`,
      ttlSeconds: window.ttlSeconds,
      apnsCollapseId: `game-start-${args.gameId}`.slice(0, 64),
      apnsExpirationSeconds: window.apnsExpirationSeconds,
    },
    { deadlineAtMs: window.deadlineAtMs },
  );

  const byToken = new Map((delivery.outcomes ?? []).map((outcome) => [outcome.token, outcome]));
  const results: Array<{ id: string; status: string; error: string | null }> = [];
  for (const row of claimed) {
    const outcome = byToken.get(row.fcm_token);
    const status = outcome?.status === "accepted"
      ? "accepted"
      : outcome?.status === "transient" || !outcome
        ? "transient"
        : "permanent_failed";
    results.push({ id: row.id, status, error: outcome?.errorCode ?? null });
  }

  const settleRemainingMs = attemptDeadlineAtMs - Date.now();
  if (settleRemainingMs <= 0) {
    throw new Error("start delivery settle: deadline_exceeded");
  }
  // query-guard: bounded -- claim 최대 500행을 단일 transaction/RPC로 원자 settle한다.
  // HTTP도 attempt 절대마감으로 abort해 45초 lease 안에 반드시 종결한다.
  const settleQuery = supabase.rpc("settle_game_start_delivery_batch", {
    p_results: results,
    p_lease_token: leaseToken,
  }).abortSignal(AbortSignal.timeout(Math.max(1, settleRemainingMs)));
  const { data: settled, error: settleError } = await settleQuery;
  if (settleError) throw new Error(`start delivery settle: ${settleError.message}`);
  const fcmAcceptedDelta = Number(settled ?? 0);

  return {
    ...(await finalizeGameStartSnapshot(args.gameId, fcmAcceptedDelta, attemptDeadlineAtMs)),
    claimed: claimed.length,
  };
}

/**
 * 단일 게임 호환 wrapper. 프로덕션 다경기 경로는 game-status의 snapshot-first
 * round-robin을 사용한다.
 */
export async function deliverGameStartSnapshot(args: GameStartDeliveryTarget & {
  attemptDeadlineAtMs?: number;
}): Promise<GameStartDeliveryResult> {
  const snapshotDeadlineAtMs = await openGameStartSnapshot({
    ...args,
    requestDeadlineAtMs: args.attemptDeadlineAtMs,
  });
  const drainDeadlineAtMs = Math.min(
    snapshotDeadlineAtMs,
    args.attemptDeadlineAtMs ?? snapshotDeadlineAtMs,
  );
  let acceptedDelta = 0;
  await drainGameStartDeliveryBatches({
    deadlineAtMs: drainDeadlineAtMs,
    claim: async () => {
      const batch = await deliverGameStartBatch({
        ...args,
        snapshotDeadlineAtMs,
        attemptDeadlineAtMs: Math.min(
          drainDeadlineAtMs,
          Date.now() + START_DELIVERY_ATTEMPT_MS,
        ),
      });
      acceptedDelta += batch.fcmAcceptedDelta;
      return batch.claimed > 0 && batch.pending > 0 ? [batch] : [];
    },
    process: async () => 0,
  });
  return finalizeGameStartSnapshot(args.gameId, acceptedDelta, drainDeadlineAtMs);
}
