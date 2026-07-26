import { randomUUID } from "node:crypto";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { sendFcmToTokens, type PushPayload } from "@/lib/notifications/fcm";

const SNAPSHOT_DEADLINE_MS = 90_000;

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
  fcmAccepted: number;
  deviceDelivered: number;
  pending: number;
  permanentFailed: number;
  expired: number;
};

const EMPTY: GameStartDeliveryResult = {
  snapshotCompleted: false,
  fcmAccepted: 0,
  deviceDelivered: 0,
  pending: 0,
  permanentFailed: 0,
  expired: 0,
};

async function finalize(gameId: string): Promise<GameStartDeliveryResult> {
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
  if (!row) return EMPTY;
  return {
    snapshotCompleted: Boolean(row.snapshot_completed),
    fcmAccepted: Number(row.accepted ?? 0),
    deviceDelivered: Number(row.device_delivered ?? 0),
    pending: Number(row.pending ?? 0),
    permanentFailed: Number(row.permanent_failed ?? 0),
    expired: Number(row.expired ?? 0),
  };
}

/**
 * 최초 eligible device 스냅샷만 발송한다. 이후 등록/교체 토큰은 스냅샷에 들어오지 않는다.
 * FCM accepted와 deviceDelivered는 별도 축이며, accepted를 실도달로 해석하지 않는다.
 */
export async function deliverGameStartSnapshot(args: {
  gameId: string;
  teamIds: number[];
  observedAtMs: number;
  payload: PushPayload;
}): Promise<GameStartDeliveryResult> {
  const deadlineAtMs = args.observedAtMs + SNAPSHOT_DEADLINE_MS;
  // query-guard: bounded -- 단일 game snapshot 생성 여부 boolean 1개만 반환한다.
  const { error: snapshotError } = await supabase.rpc("snapshot_game_start_deliveries", {
    p_game_id: args.gameId,
    p_team_ids: args.teamIds,
    p_snapshot_at: new Date(args.observedAtMs).toISOString(),
    p_deadline_at: new Date(deadlineAtMs).toISOString(),
  });
  if (snapshotError) throw new Error(`start delivery snapshot: ${snapshotError.message}`);

  if (Date.now() >= deadlineAtMs) return finalize(args.gameId);

  const leaseToken = randomUUID();
  // query-guard: bounded -- SQL RPC가 p_limit을 최대 500행으로 clamp한다.
  const { data, error: claimError } = await supabase.rpc("claim_game_start_deliveries", {
    p_game_id: args.gameId,
    p_lease_token: leaseToken,
    p_lease_seconds: 20,
    p_limit: 500,
  });
  if (claimError) throw new Error(`start delivery claim: ${claimError.message}`);
  const claimed = (data ?? []) as ClaimedDelivery[];
  if (claimed.length === 0) return finalize(args.gameId);

  const remainingSeconds = Math.max(1, Math.ceil((deadlineAtMs - Date.now()) / 1000));
  const delivery = await sendFcmToTokens(
    claimed.map((row) => row.fcm_token),
    {
      ...args.payload,
      collapseKey: `game_start_${args.gameId}`,
      ttlSeconds: Math.min(90, remainingSeconds),
      apnsCollapseId: `game-start-${args.gameId}`.slice(0, 64),
      apnsExpirationSeconds: Math.min(90, remainingSeconds),
    },
    { deadlineAtMs },
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

  for (const [status, ids] of Object.entries(groups)) {
    if (ids.length === 0) continue;
    // query-guard: bounded -- 위 claim 최대 500행의 상태 전이 건수 scalar 1개만 반환한다.
    const { error } = await supabase.rpc("settle_game_start_deliveries", {
      p_ids: ids,
      p_lease_token: leaseToken,
      p_status: status,
      p_error: errors.get(status) ?? null,
    });
    if (error) throw new Error(`start delivery settle(${status}): ${error.message}`);
  }

  return finalize(args.gameId);
}
