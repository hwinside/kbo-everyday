import { randomUUID } from "node:crypto";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { sendFcmToTokens, type PushPayload } from "@/lib/notifications/fcm";
import {
  drainGameStartDeliveryBatches,
  gameStartDeliveryWindow,
} from "@/lib/notifications/game-start-delivery-policy";

const SNAPSHOT_DEADLINE_MS = 90_000;
export const START_DELIVERY_ATTEMPT_MS = 8_000;
const START_DELIVERY_LEASE_SECONDS = 20;

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
): Promise<GameStartDeliveryResult> {
  // query-guard: bounded -- 단일 game_id 집계 결과를 정확히 1행 반환한다.
  const { data, error } = await supabase.rpc("finalize_game_start_deliveries", {
    p_game_id: gameId,
  });
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
export async function openGameStartSnapshot(args: GameStartDeliveryTarget): Promise<number> {
  const proposedDeadlineAtMs = args.observedAtMs + SNAPSHOT_DEADLINE_MS;
  // query-guard: bounded -- 단일 game snapshot의 persisted deadline scalar 1개만 반환한다.
  const { data: snapshotDeadline, error: snapshotError } = await supabase.rpc("snapshot_game_start_deliveries", {
    p_game_id: args.gameId,
    p_team_ids: args.teamIds,
    p_snapshot_at: new Date(args.observedAtMs).toISOString(),
    p_deadline_at: new Date(proposedDeadlineAtMs).toISOString(),
  });
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
    return { ...(await finalizeGameStartSnapshot(args.gameId)), claimed: 0 };
  }

  const leaseToken = randomUUID();
  // transport는 8초 이내로 bound하고 lease는 20초로 감싸 중첩 send를 막되,
  // worker crash 뒤 다음 1분 cron이 최초 90초 deadline 안에서 재claim할 수 있게 한다.
  // query-guard: bounded -- SQL RPC가 p_limit을 최대 500행으로 clamp한다.
  const { data, error: claimError } = await supabase.rpc("claim_game_start_deliveries", {
    p_game_id: args.gameId,
    p_lease_token: leaseToken,
    p_lease_seconds: START_DELIVERY_LEASE_SECONDS,
    p_limit: 500,
  });
  if (claimError) throw new Error(`start delivery claim: ${claimError.message}`);
  const claimed = (data ?? []) as ClaimedDelivery[];
  if (claimed.length === 0) {
    return { ...(await finalizeGameStartSnapshot(args.gameId)), claimed: 0 };
  }

  const window = gameStartDeliveryWindow(
    args.snapshotDeadlineAtMs,
    Date.now(),
    attemptDeadlineAtMs,
  );
  if (!window) {
    return { ...(await finalizeGameStartSnapshot(args.gameId)), claimed: claimed.length };
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
  const groups = {
    accepted: [] as string[],
    transient: [] as string[],
    permanent_failed: [] as string[],
  };
  const errors = new Map<string, string>();
  for (const row of claimed) {
    const outcome = byToken.get(row.fcm_token);
    const status = outcome?.status === "accepted"
      ? "accepted"
      : outcome?.status === "transient" || !outcome
        ? "transient"
        : "permanent_failed";
    groups[status].push(row.id);
    if (outcome?.errorCode) errors.set(status, outcome.errorCode);
  }

  let fcmAcceptedDelta = 0;
  for (const [status, ids] of Object.entries(groups)) {
    if (ids.length === 0) continue;
    // query-guard: bounded -- 위 claim 최대 500행의 상태 전이 건수 scalar 1개만 반환한다.
    const { data: settled, error } = await supabase.rpc("settle_game_start_deliveries", {
      p_ids: ids,
      p_lease_token: leaseToken,
      p_status: status,
      p_error: errors.get(status) ?? null,
    });
    if (error) throw new Error(`start delivery settle(${status}): ${error.message}`);
    if (status === "accepted") fcmAcceptedDelta += Number(settled ?? 0);
  }

  return {
    ...(await finalizeGameStartSnapshot(args.gameId, fcmAcceptedDelta)),
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
  const snapshotDeadlineAtMs = await openGameStartSnapshot(args);
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
  return finalizeGameStartSnapshot(args.gameId, acceptedDelta);
}
