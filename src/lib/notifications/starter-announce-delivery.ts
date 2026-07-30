/**
 * 예고선발 공개 푸시 전달 — (game_id, team_id) 단위 durable 스냅샷/전달.
 * 라인업 확정 푸시(lineup-confirm-delivery.ts)의 원장 규율(lease fencing · at-most-once dispatch intent ·
 * batch settle · deadline 만료 · RPC remaining-budget abort)을 event 'starter_announce' 로 그대로 클론한다.
 */
import { randomUUID } from "node:crypto";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { sendFcmToTokens, type PushPayload } from "@/lib/notifications/fcm";

// 공개 관측~재시도 여유. 이 안에서만 transient 재시도, 초과 시 finalize 가 expired.
const SNAPSHOT_DEADLINE_MS = 30 * 60_000;
const STARTER_DELIVERY_TRANSPORT_MS = 8_000;
export const STARTER_DELIVERY_ATTEMPT_MS = 14_000;
// settle+finalize 전용 예약 예산. FCM transport 는 attempt deadline 보다 이만큼 먼저 끝나게 해
// 외부 전송이 예산을 다 써도 settle 가 항상 실행된다(dispatch_started_at 행이 미settle 로 남지 않게).
const STARTER_SETTLE_RESERVE_MS = 2_500;
const STARTER_DELIVERY_LEASE_SECONDS = 45;
const STARTER_PUSH_TTL_SECONDS = 30 * 60;

type ClaimedDelivery = {
  id: string;
  token_id: number;
  token_hash: string;
  platform: "ios" | "android";
  fcm_token: string;
  deadline_at: string;
};

export type StarterDeliveryResult = {
  snapshotCompleted: boolean;
  fcmAcceptedDelta: number;
  fcmAcceptedTotal: number;
  pending: number;
  permanentFailed: number;
  expired: number;
};
export type StarterDeliveryBatchResult = StarterDeliveryResult & {
  claimed: number;
  // settle 예약분 미달로 이번 batch 를 아예 시작하지 못한 non-terminal 신호.
  // 원장은 그대로라 다음 tick 에 이어 drain — 진짜 terminal(claim 0·finalize 실행)과 구분된다.
  budgetSkipped?: boolean;
};
export type StarterDeliveryTarget = {
  gameId: string;
  teamId: number;
  observedAtMs: number;
  payload: PushPayload;
};

const EMPTY: StarterDeliveryResult = {
  snapshotCompleted: false,
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

export async function finalizeStarterSnapshot(
  gameId: string,
  teamId: number,
  fcmAcceptedDelta = 0,
  requestDeadlineAtMs?: number,
): Promise<StarterDeliveryResult> {
  const remaining = remainingMs(requestDeadlineAtMs, "starter delivery finalize");
  // query-guard: bounded -- 단일 (game,team) 집계 1행만 반환.
  const { data, error } = await withAbort(
    supabase.rpc("finalize_starter_announce_deliveries", { p_game_id: gameId, p_team_id: teamId }),
    remaining,
  );
  if (error) throw new Error(`starter delivery finalize: ${error.message}`);
  const row = (data?.[0] ?? null) as {
    snapshot_completed?: boolean;
    accepted?: number;
    pending?: number;
    permanent_failed?: number;
    expired?: number;
  } | null;
  if (!row) return { ...EMPTY, fcmAcceptedDelta };
  return {
    snapshotCompleted: Boolean(row.snapshot_completed),
    fcmAcceptedDelta,
    fcmAcceptedTotal: Number(row.accepted ?? 0),
    pending: Number(row.pending ?? 0),
    permanentFailed: Number(row.permanent_failed ?? 0),
    expired: Number(row.expired ?? 0),
  };
}

/** 열린(미완료) due-ledger 스냅샷 상태. 현재 KBO/게임 상태와 무관하게 이어 drain 할 대상. */
export type DueStarterSnapshot = {
  gameId: string;
  teamId: number;
  snapshotDeadlineAtMs: number;
  payload: PushPayload;
};

/** starter_notified=false 이면서 스냅샷이 열린 (game,team) 상태를 deadline 순으로 반환. payload 는 스냅샷 시점 값 재사용. */
export async function listDueStarterSnapshots(requestDeadlineAtMs?: number, limit = 200): Promise<DueStarterSnapshot[]> {
  const remaining = remainingMs(requestDeadlineAtMs, "starter delivery list-due");
  // query-guard: bounded -- SQL RPC 가 p_limit 을 500행으로 clamp.
  const { data, error } = await withAbort(
    supabase.rpc("list_due_starter_announce_snapshots", { p_limit: limit }),
    remaining,
  );
  if (error) throw new Error(`starter delivery list-due: ${error.message}`);
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
      title: r.push_title ?? "예고선발 공개",
      body: r.push_body ?? "예고선발이 공개되었습니다. 선발 맞대결을 확인해보세요.",
      url: r.push_url ?? `/games/${r.game_id}`,
    },
  }));
}

/** 경기별 선발 공시 관측 판정. emit=실제 빈값→공식값 전이(발송 대상) · baseline=rollout 기공개(발송 금지) · wait=미공개. */
export type StarterObserveAction = "emit" | "baseline" | "wait";

/**
 * 이번 tick 의 경기별 관측(양팀 공식값 여부)을 DB 관측 원장(game_starter_observation)에 기록하고
 * 전이 판정을 받는다(단일 batch RPC). 빈값 관측 이력 없는 공식값(배포 첫 tick 기공개)은 'baseline' —
 * 발송 금지. 실제 빈값→공식값 전이만 'emit'.
 */
export async function observeStarterAnnounceGames(
  observations: Array<{ gameId: string; bothOfficial: boolean }>,
  requestDeadlineAtMs?: number,
): Promise<Map<string, StarterObserveAction>> {
  if (observations.length === 0) return new Map();
  const remaining = remainingMs(requestDeadlineAtMs, "starter observe");
  // query-guard: bounded -- SQL RPC 가 관측 배열을 200행으로 clamp, 경기당 1행 반환.
  const { data, error } = await withAbort(
    supabase.rpc("observe_starter_announce_games", {
      p_observations: observations.map((o) => ({ game_id: o.gameId, both_official: o.bothOfficial })),
    }),
    remaining,
  );
  if (error) throw new Error(`starter observe: ${error.message}`);
  const rows = (data ?? []) as Array<{ game_id: string; action: string }>;
  const map = new Map<string, StarterObserveAction>();
  for (const r of rows) {
    if (r.action === "emit" || r.action === "baseline" || r.action === "wait") map.set(r.game_id, r.action);
  }
  return map;
}

/**
 * (game,team) 최초 대상 스냅샷 생성. persisted deadline(ms) 반환. RPC 는 잔여 예산으로 abort.
 * 이미 종결된 state(starter_notified=true)면 RPC 가 null 을 반환 → null 그대로 넘겨 호출부(cron)가
 * drain/finalize 를 완전히 skip 한다(완료 state 매 tick 재처리 금지).
 */
export async function openStarterSnapshot(
  args: StarterDeliveryTarget & { requestDeadlineAtMs?: number },
): Promise<number | null> {
  const remaining = remainingMs(args.requestDeadlineAtMs, "starter delivery snapshot");
  const proposedDeadlineAtMs = args.observedAtMs + SNAPSHOT_DEADLINE_MS;
  // query-guard: bounded -- persisted deadline scalar 1개만 반환.
  const { data: snapshotDeadline, error } = await withAbort(
    supabase.rpc("snapshot_starter_announce_deliveries", {
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
  if (error) throw new Error(`starter delivery snapshot: ${error.message}`);
  if (snapshotDeadline == null) return null; // 종결된 (game,team) — 호출부가 완전히 skip
  const deadlineAtMs = Date.parse(String(snapshotDeadline));
  if (!Number.isFinite(deadlineAtMs)) throw new Error("starter delivery snapshot: invalid persisted deadline");
  return deadlineAtMs;
}

/** 한 (game,team)에서 최대 500행 1 batch 처리: claim→dispatch intent→FCM→batch settle→finalize. */
export async function deliverStarterBatch(
  args: StarterDeliveryTarget & { snapshotDeadlineAtMs: number; attemptDeadlineAtMs: number },
): Promise<StarterDeliveryBatchResult> {
  const attemptDeadlineAtMs = Math.min(args.snapshotDeadlineAtMs, args.attemptDeadlineAtMs);
  // settle 예약분(2.5s)조차 없으면 claim 도 시작하지 않는다. budgetSkipped 로 표식 — watchdog 이 이걸
  // 진짜 terminal(원장 비어 claim 0)과 구분해 마지막 informative counters 를 덮지 않게 한다.
  if (Date.now() >= attemptDeadlineAtMs - STARTER_SETTLE_RESERVE_MS) return { ...EMPTY, claimed: 0, budgetSkipped: true };

  const leaseToken = randomUUID();
  // query-guard: bounded -- SQL RPC 가 p_limit 을 500행으로 clamp.
  const claimRemaining = remainingMs(attemptDeadlineAtMs, "starter delivery claim")!;
  const { data, error: claimError } = await withAbort(
    supabase.rpc("claim_starter_announce_deliveries", {
      p_game_id: args.gameId,
      p_team_id: args.teamId,
      p_lease_token: leaseToken,
      p_lease_seconds: STARTER_DELIVERY_LEASE_SECONDS,
      p_limit: 500,
    }),
    claimRemaining,
  );
  if (claimError) throw new Error(`starter delivery claim: ${claimError.message}`);
  const claimed = (data ?? []) as ClaimedDelivery[];
  if (claimed.length === 0) {
    return { ...(await finalizeStarterSnapshot(args.gameId, args.teamId, 0, attemptDeadlineAtMs)), claimed: 0 };
  }

  // 외부 FCM 직전 durable intent — 성공행은 snapshot deadline 까지 재claim 금지(at-most-once).
  // query-guard: bounded -- p_ids 는 직전 claim(≤500행)의 id 집합이라 상한이 명확하다.
  const dispatchRemaining = remainingMs(attemptDeadlineAtMs, "starter delivery dispatch intent")!;
  const { data: dispatching, error: dispatchError } = await withAbort(
    supabase.rpc("mark_starter_announce_deliveries_dispatching", {
      p_ids: claimed.map((r) => r.id),
      p_lease_token: leaseToken,
    }),
    dispatchRemaining,
  );
  if (dispatchError) throw new Error(`starter delivery dispatch intent: ${dispatchError.message}`);
  if (Number(dispatching ?? 0) !== claimed.length) {
    throw new Error("starter delivery dispatch intent: fencing mismatch");
  }

  // transport 는 attempt deadline 보다 settle 예약분 이만큼 먼저 끝난다 → settle/finalize 가 항상 예산 확보.
  const transportDeadlineAtMs = Math.min(
    attemptDeadlineAtMs - STARTER_SETTLE_RESERVE_MS,
    Date.now() + STARTER_DELIVERY_TRANSPORT_MS,
  );
  const delivery = await sendFcmToTokens(
    claimed.map((r) => r.fcm_token),
    {
      ...args.payload,
      collapseKey: `starter_announce_${args.gameId}_${args.teamId}`,
      ttlSeconds: STARTER_PUSH_TTL_SECONDS,
      apnsCollapseId: `starter-announce-${args.gameId}-${args.teamId}`.slice(0, 64),
      apnsExpirationSeconds: STARTER_PUSH_TTL_SECONDS,
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
  const settleRemaining = remainingMs(attemptDeadlineAtMs, "starter delivery settle")!;
  const { data: settled, error: settleError } = await withAbort(
    supabase.rpc("settle_starter_announce_delivery_batch", { p_results: results, p_lease_token: leaseToken }),
    settleRemaining,
  );
  if (settleError) throw new Error(`starter delivery settle: ${settleError.message}`);
  const fcmAcceptedDelta = Number(settled ?? 0);

  return {
    ...(await finalizeStarterSnapshot(args.gameId, args.teamId, fcmAcceptedDelta, attemptDeadlineAtMs)),
    claimed: claimed.length,
  };
}
