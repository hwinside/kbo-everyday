/**
 * 라인업 확정 푸시 전달 — (game_id, team_id) 단위 durable 스냅샷/전달 (하린아빠 gate ①②③).
 * 경기 시작 푸시(game-start-delivery.ts)의 원장 규율(lease fencing · at-most-once dispatch intent ·
 * batch settle · deadline 만료 · RPC remaining-budget abort)을 그대로 따른다. 라인업은 pre-game 이라
 * self-contained TTL 을 쓴다.
 */
import { randomUUID } from "node:crypto";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { sendFcmToTokens, type PushPayload } from "@/lib/notifications/fcm";

// 라인업 확정~경기 시작 사이 재시도 여유. 이 안에서만 transient 재시도, 초과 시 finalize 가 expired.
const SNAPSHOT_DEADLINE_MS = 30 * 60_000;
const LINEUP_DELIVERY_TRANSPORT_MS = 8_000;
export const LINEUP_DELIVERY_ATTEMPT_MS = 14_000;
// settle+finalize 전용 예약 예산. FCM transport 는 attempt deadline 보다 이만큼 먼저 끝나게 해
// 외부 전송이 예산을 다 써도 settle 가 항상 실행된다(dispatch_started_at 행이 미settle 로 남지 않게, 삼순 #952 3차 re-gate).
const LINEUP_SETTLE_RESERVE_MS = 2_500;
const LINEUP_DELIVERY_LEASE_SECONDS = 45;
const LINEUP_PUSH_TTL_SECONDS = 30 * 60;

type ClaimedDelivery = {
  id: string;
  token_id: number;
  token_hash: string;
  platform: "ios" | "android";
  fcm_token: string;
  deadline_at: string;
};

export type LineupDeliveryResult = {
  snapshotCompleted: boolean;
  deliveryStatus: "pending" | "delivered" | "partial" | "failed";
  fcmAcceptedDelta: number;
  fcmAcceptedTotal: number;
  pending: number;
  permanentFailed: number;
  expired: number;
};
export type LineupDeliveryBatchResult = LineupDeliveryResult & {
  claimed: number;
  // settle 예약분 미달로 이번 batch 를 아예 시작하지 못한 non-terminal 신호(삼순 #952 7차+).
  // 원장은 그대로라 다음 tick 에 이어 drain — 진짜 terminal(claim 0·finalize 실행)과 구분된다.
  budgetSkipped?: boolean;
};
export type LineupDeliveryTarget = {
  gameId: string;
  teamId: number;
  observedAtMs: number;
  payload: PushPayload;
};

const EMPTY: LineupDeliveryResult = {
  snapshotCompleted: false,
  deliveryStatus: "pending",
  fcmAcceptedDelta: 0,
  fcmAcceptedTotal: 0,
  pending: 0,
  permanentFailed: 0,
  expired: 0,
};

/** 잔여 예산(ms). deadline 초과면 throw 해 DB/FCM 부작용을 시작하지 않는다. */
function remainingMs(deadlineAtMs: number | undefined, op: string): number | null {
  if (deadlineAtMs == null) return null;
  const remaining = deadlineAtMs - Date.now();
  if (remaining <= 0) throw new Error(`${op}: deadline_exceeded`);
  return remaining;
}
function withAbort<T extends { abortSignal(signal: AbortSignal): T }>(query: T, remaining: number | null): T {
  return remaining != null ? query.abortSignal(AbortSignal.timeout(Math.max(1, remaining))) : query;
}

export async function finalizeLineupSnapshot(
  gameId: string,
  teamId: number,
  fcmAcceptedDelta = 0,
  requestDeadlineAtMs?: number,
): Promise<LineupDeliveryResult> {
  const remaining = remainingMs(requestDeadlineAtMs, "lineup delivery finalize");
  // query-guard: bounded -- 단일 (game,team) 집계 1행만 반환.
  const { data, error } = await withAbort(
    supabase.rpc("finalize_lineup_confirm_deliveries", { p_game_id: gameId, p_team_id: teamId }),
    remaining,
  );
  if (error) throw new Error(`lineup delivery finalize: ${error.message}`);
  const row = (data?.[0] ?? null) as {
    snapshot_completed?: boolean;
    accepted?: number;
    pending?: number;
    permanent_failed?: number;
    expired?: number;
  } | null;
  if (!row) return { ...EMPTY, fcmAcceptedDelta };
  const accepted = Number(row.accepted ?? 0);
  const pending = Number(row.pending ?? 0);
  const permanentFailed = Number(row.permanent_failed ?? 0);
  const expired = Number(row.expired ?? 0);
  const deliveryStatus = pending > 0
    ? "pending"
    : accepted > 0 && (permanentFailed > 0 || expired > 0)
      ? "partial"
      : accepted === 0 && (permanentFailed > 0 || expired > 0)
        ? "failed"
        : "delivered";
  return {
    snapshotCompleted: Boolean(row.snapshot_completed),
    deliveryStatus,
    fcmAcceptedDelta,
    fcmAcceptedTotal: accepted,
    pending,
    permanentFailed,
    expired,
  };
}

/** 열린(미완료) due-ledger 스냅샷 상태. 현재 KBO/게임 상태와 무관하게 이어 drain 할 대상. */
export type DueLineupSnapshot = {
  gameId: string;
  teamId: number;
  snapshotDeadlineAtMs: number;
  payload: PushPayload;
};

/** delivery_status=pending 이면서 스냅샷이 열린 (game,team) 상태를 deadline 순으로 반환. payload 는 스냅샷 시점 값 재사용. */
export async function listDueLineupSnapshots(requestDeadlineAtMs?: number, limit = 200): Promise<DueLineupSnapshot[]> {
  const remaining = remainingMs(requestDeadlineAtMs, "lineup delivery list-due");
  // query-guard: bounded -- SQL RPC 가 p_limit 을 500행으로 clamp.
  const { data, error } = await withAbort(
    supabase.rpc("list_due_lineup_confirm_snapshots", { p_limit: limit }),
    remaining,
  );
  if (error) throw new Error(`lineup delivery list-due: ${error.message}`);
  const rows = (data ?? []) as Array<{
    game_id: string;
    team_id: number;
    snapshot_deadline_at: string;
    push_title: string | null;
    push_body: string | null;
    push_url: string | null;
  }>;
  return rows.map((r) => ({
    gameId: r.game_id,
    teamId: r.team_id,
    snapshotDeadlineAtMs: Date.parse(r.snapshot_deadline_at),
    payload: {
      title: r.push_title ?? "라인업 확정",
      body: r.push_body ?? "라인업이 확정되었습니다. 자세한 라인업을 확인해보세요.",
      url: r.push_url ?? `/games/${r.game_id}?tab=lineup`,
    },
  }));
}

/** (game,team) 최초 대상 스냅샷 생성. persisted deadline(ms) 반환. RPC 는 잔여 예산으로 abort. */
export async function openLineupSnapshot(
  args: LineupDeliveryTarget & { requestDeadlineAtMs?: number },
): Promise<number> {
  const remaining = remainingMs(args.requestDeadlineAtMs, "lineup delivery snapshot");
  const proposedDeadlineAtMs = args.observedAtMs + SNAPSHOT_DEADLINE_MS;
  // query-guard: bounded -- persisted deadline scalar 1개만 반환.
  const { data: snapshotDeadline, error } = await withAbort(
    supabase.rpc("snapshot_lineup_confirm_deliveries", {
      p_game_id: args.gameId,
      p_team_id: args.teamId,
      p_snapshot_at: new Date(args.observedAtMs).toISOString(),
      p_deadline_at: new Date(proposedDeadlineAtMs).toISOString(),
      p_title: args.payload.title,
      p_body: args.payload.body,
      p_url: args.payload.url ?? null,
    }),
    remaining,
  );
  if (error) throw new Error(`lineup delivery snapshot: ${error.message}`);
  const deadlineAtMs = Date.parse(String(snapshotDeadline ?? ""));
  if (!Number.isFinite(deadlineAtMs)) throw new Error("lineup delivery snapshot: invalid persisted deadline");
  return deadlineAtMs;
}

/** 한 (game,team)에서 최대 500행 1 batch 처리: claim→dispatch intent→FCM→batch settle→finalize. */
export async function deliverLineupBatch(
  args: LineupDeliveryTarget & { snapshotDeadlineAtMs: number; attemptDeadlineAtMs: number },
): Promise<LineupDeliveryBatchResult> {
  const attemptDeadlineAtMs = Math.min(args.snapshotDeadlineAtMs, args.attemptDeadlineAtMs);
  // settle 예약분까지 남지 않으면 이번 batch 를 시작하지 않는다(claim 후 settle 못해 dispatch_started_at 행이 뜼는 것 방지).
  // settle 예약분(2.5s)조차 없으면 claim 도 시작하지 않는다. budgetSkipped 로 표식 — watchdog 이 이걸
  // 진짜 terminal(원장 비어 claim 0)과 구분해 마지막 informative counters 를 덮지 않게 한다(삼순 #952 7차).
  if (Date.now() >= attemptDeadlineAtMs - LINEUP_SETTLE_RESERVE_MS) return { ...EMPTY, claimed: 0, budgetSkipped: true };

  const leaseToken = randomUUID();
  // query-guard: bounded -- SQL RPC 가 p_limit 을 500행으로 clamp.
  const claimRemaining = remainingMs(attemptDeadlineAtMs, "lineup delivery claim")!;
  const { data, error: claimError } = await withAbort(
    supabase.rpc("claim_lineup_confirm_deliveries", {
      p_game_id: args.gameId,
      p_team_id: args.teamId,
      p_lease_token: leaseToken,
      p_lease_seconds: LINEUP_DELIVERY_LEASE_SECONDS,
      p_limit: 500,
    }),
    claimRemaining,
  );
  if (claimError) throw new Error(`lineup delivery claim: ${claimError.message}`);
  const claimed = (data ?? []) as ClaimedDelivery[];
  if (claimed.length === 0) {
    return { ...(await finalizeLineupSnapshot(args.gameId, args.teamId, 0, attemptDeadlineAtMs)), claimed: 0 };
  }

  // 외부 FCM 직전 durable intent — 성공행은 snapshot deadline 까지 재claim 금지(at-most-once).
  // query-guard: bounded -- p_ids 는 직전 claim(≤500행)의 id 집합이라 상한이 명확하다.
  const dispatchRemaining = remainingMs(attemptDeadlineAtMs, "lineup delivery dispatch intent")!;
  const { data: dispatching, error: dispatchError } = await withAbort(
    supabase.rpc("mark_lineup_confirm_deliveries_dispatching", {
      p_ids: claimed.map((r) => r.id),
      p_lease_token: leaseToken,
    }),
    dispatchRemaining,
  );
  if (dispatchError) throw new Error(`lineup delivery dispatch intent: ${dispatchError.message}`);
  if (Number(dispatching ?? 0) !== claimed.length) {
    throw new Error("lineup delivery dispatch intent: fencing mismatch");
  }

  // transport 는 attempt deadline 보다 settle 예약분 이만큼 먼저 끝난다 → settle/finalize 가 항상 예산 확보.
  const transportDeadlineAtMs = Math.min(
    attemptDeadlineAtMs - LINEUP_SETTLE_RESERVE_MS,
    Date.now() + LINEUP_DELIVERY_TRANSPORT_MS,
  );
  const delivery = await sendFcmToTokens(
    claimed.map((r) => r.fcm_token),
    {
      ...args.payload,
      collapseKey: `lineup_confirm_${args.gameId}_${args.teamId}`,
      ttlSeconds: LINEUP_PUSH_TTL_SECONDS,
      apnsCollapseId: `lineup-confirm-${args.gameId}-${args.teamId}`.slice(0, 64),
      apnsExpirationSeconds: LINEUP_PUSH_TTL_SECONDS,
    },
    { deadlineAtMs: transportDeadlineAtMs },
  );

  const byToken = new Map((delivery.outcomes ?? []).map((o) => [o.token, o]));
  const results = claimed.map((row) => {
    const outcome = byToken.get(row.fcm_token);
    const status =
      outcome?.status === "accepted"
        ? "accepted"
        : outcome?.status === "transient" || !outcome
          ? "transient"
          : "permanent_failed";
    return { id: row.id, status, error: outcome?.errorCode ?? null };
  });

  // query-guard: bounded -- claim 최대 500행을 단일 RPC 로 원자 settle.
  const settleRemaining = remainingMs(attemptDeadlineAtMs, "lineup delivery settle")!;
  const { data: settled, error: settleError } = await withAbort(
    supabase.rpc("settle_lineup_confirm_delivery_batch", { p_results: results, p_lease_token: leaseToken }),
    settleRemaining,
  );
  if (settleError) throw new Error(`lineup delivery settle: ${settleError.message}`);
  const fcmAcceptedDelta = Number(settled ?? 0);

  return {
    ...(await finalizeLineupSnapshot(args.gameId, args.teamId, fcmAcceptedDelta, attemptDeadlineAtMs)),
    claimed: claimed.length,
  };
}

/** 단일 (game,team) 라인업 확정 전달: 스냅샷 → deadline/attempt 안에서 batch drain → finalize. */
export async function deliverLineupConfirm(
  args: LineupDeliveryTarget & { attemptDeadlineAtMs?: number },
): Promise<LineupDeliveryResult> {
  const snapshotDeadlineAtMs = await openLineupSnapshot({ ...args, requestDeadlineAtMs: args.attemptDeadlineAtMs });
  const drainDeadlineAtMs = Math.min(snapshotDeadlineAtMs, args.attemptDeadlineAtMs ?? snapshotDeadlineAtMs);
  let acceptedDelta = 0;
  for (let i = 0; i < 8 && Date.now() < drainDeadlineAtMs; i++) {
    const batch = await deliverLineupBatch({
      ...args,
      snapshotDeadlineAtMs,
      attemptDeadlineAtMs: Math.min(drainDeadlineAtMs, Date.now() + LINEUP_DELIVERY_ATTEMPT_MS),
    });
    acceptedDelta += batch.fcmAcceptedDelta;
    if (batch.claimed === 0 || batch.pending === 0) break;
  }
  return finalizeLineupSnapshot(args.gameId, args.teamId, acceptedDelta, drainDeadlineAtMs);
}
