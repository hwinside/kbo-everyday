import { randomUUID } from "node:crypto";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { sendFcmToTokens, type PushPayload } from "@/lib/notifications/fcm";
import {
  drainGameStartDeliveryBatches,
  gameStartDeliveryWindow,
} from "@/lib/notifications/game-start-delivery-policy";

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

const EMPTY: GameStartDeliveryResult = {
  snapshotCompleted: false,
  fcmAcceptedDelta: 0,
  fcmAcceptedTotal: 0,
  deviceDelivered: null,
  pending: 0,
  permanentFailed: 0,
  expired: 0,
};

async function finalize(gameId: string, fcmAcceptedDelta = 0): Promise<GameStartDeliveryResult> {
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

/**
 * 최초 eligible device 스냅샷만 발송한다. 이후 등록/교체 토큰은 스냅샷에 들어오지 않는다.
 * FCM accepted와 deviceDelivered는 별도 축이며, accepted를 실도달로 해석하지 않는다.
 */
export async function deliverGameStartSnapshot(args: {
  gameId: string;
  teamIds: number[];
  observedAtMs: number;
  payload: PushPayload;
  /** Vercel invocation의 요청-절대 작업 마감. snapshot deadline보다 짧을 수 있다. */
  attemptDeadlineAtMs?: number;
}): Promise<GameStartDeliveryResult> {
  const proposedDeadlineAtMs = args.observedAtMs + SNAPSHOT_DEADLINE_MS;
  // query-guard: bounded -- 단일 game snapshot 생성 여부 boolean 1개만 반환한다.
  const { data: snapshotDeadline, error: snapshotError } = await supabase.rpc("snapshot_game_start_deliveries", {
    p_game_id: args.gameId,
    p_team_ids: args.teamIds,
    p_snapshot_at: new Date(args.observedAtMs).toISOString(),
    p_deadline_at: new Date(proposedDeadlineAtMs).toISOString(),
  });
  if (snapshotError) throw new Error(`start delivery snapshot: ${snapshotError.message}`);
  const deadlineAtMs = Date.parse(String(snapshotDeadline ?? ""));
  if (!Number.isFinite(deadlineAtMs)) throw new Error("start delivery snapshot: invalid persisted deadline");

  const drainDeadlineAtMs = Math.min(deadlineAtMs, args.attemptDeadlineAtMs ?? deadlineAtMs);
  if (Date.now() >= drainDeadlineAtMs) return finalize(args.gameId);

  let leaseToken = "";
  const fcmAcceptedDelta = await drainGameStartDeliveryBatches<ClaimedDelivery>({
    deadlineAtMs: drainDeadlineAtMs,
    claim: async () => {
      leaseToken = randomUUID();
      // query-guard: bounded -- SQL RPC가 p_limit을 최대 500행으로 clamp한다.
      const { data, error } = await supabase.rpc("claim_game_start_deliveries", {
        p_game_id: args.gameId,
        p_lease_token: leaseToken,
        p_limit: 500,
      });
      if (error) throw new Error(`start delivery claim: ${error.message}`);
      return (data ?? []) as ClaimedDelivery[];
    },
    process: async (claimed) => {
      const window = gameStartDeliveryWindow(deadlineAtMs, Date.now(), drainDeadlineAtMs);
      if (!window) return 0;
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

      let accepted = 0;
      for (const [status, ids] of Object.entries(groups)) {
        if (ids.length === 0) continue;
        // query-guard: bounded -- 위 claim 최대 500행의 상태 전이 건수 scalar 1개만 반환한다.
        const { data, error } = await supabase.rpc("settle_game_start_deliveries", {
          p_ids: ids,
          p_lease_token: leaseToken,
          p_status: status,
          p_error: errors.get(status) ?? null,
        });
        if (error) throw new Error(`start delivery settle(${status}): ${error.message}`);
        if (status === "accepted") accepted += Number(data ?? 0);
      }
      return accepted;
    },
  });

  return finalize(args.gameId, fcmAcceptedDelta);
}
