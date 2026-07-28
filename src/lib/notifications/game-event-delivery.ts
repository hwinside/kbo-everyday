// S2 Slice0 (삼순 2차 NO-GO #1/#2) — score/concede/inning-summary durable token 원장 발송.
//
// game_start-delivery / player-highlight 원장과 동형: claim RPC가 팀팬 audience를 원장에 freeze하고
// claimable 토큰 배치를 lease → 버킷(notification/data-only)별로 send 직후 settle(checkpoint) →
// transient/미시도만 다음 tick/due-drain이 재claim. accepted/permanent 토큰은 재발송 0(NO-GO #1),
// 버킷 간 crash도 앞 버킷 accepted를 재타격하지 않음(NO-GO #2).
//
// fail-closed(NO-GO #2 앵커): source event timestamp가 안정(유한 epoch)이면 n_expires_at = source+6h로
// data-only game_event를 붙이고, 없으면 notification-only로만 발송한다(now 재계산 금지 — 재시도 불변).

import { randomUUID } from "node:crypto";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { sendFcmToTokens, type SendResult } from "@/lib/notifications/fcm";
import {
  composeGameEventFanout,
  deriveGameEventExpiresAtMsOrNull,
  type GameEventSub,
  type TokenMeta,
} from "@/lib/notifications/game-event-fanout";
import { mapHighlightSettlements } from "@/lib/notifications/player-highlight-delivery";

export type ScoreFamilySub = Extract<GameEventSub, "score" | "concede" | "inning-summary">;
export type ScoreFamilyPref =
  | "my_team_score"
  | "my_team_concede"
  | "my_team_score_inning_summary";

export interface ScoreFamilyDelivery {
  eventId: string;
  gameId: string;
  sub: ScoreFamilySub;
  prefKey: ScoreFamilyPref;
  teamId: number;
  title: string;
  body: string;
  url: string;
  /** source event timestamp(ms). NaN/Infinity면 fail-closed(notification-only). */
  sourceEpochMs: number;
  /** 이 시각 이후 새 FCM transport/claim을 시작하지 않는다. */
  deadlineAtMs?: number;
}

type ClaimedRow = {
  token_id: number;
  token_hash: string;
  fcm_token: string;
  platform: string | null;
  app_build: number | null;
};

// 한 이벤트 발송의 claim 루프 상한(500×20 = 최대 1만 토큰/이벤트/tick). 무한 루프 방어.
const MAX_CLAIM_ITERATIONS = 20;
const CLAIM_BATCH = 500;
// transport는 8초 안에 bound한다(원장 lease 20초보다 짧게 유지 → lease 초과 재claim 방지).
const TRANSPORT_BUDGET_MS = 8_000;
// 원장 claim lease(초). claim RPC가 설정하는 lease_until = now()+CLAIM_LEASE_SECONDS.
const CLAIM_LEASE_SECONDS = 20;
// 한 claim→send→settle 사이클을 lease(20s)보다 짧은 attempt 예산 안에 종결해, lease 초과 응답이
// 다른 worker 재claim과 겹쳐 같은 토큰을 중복 발송하는 창을 없앨다(game-start-delivery 패턴 복제).
const ATTEMPT_BUDGET_MS = 16_000;
// transport 뒤 settle RPC가 attempt 예산 안에 끝나도록 남기는 예비 시간.
const SETTLE_RESERVE_MS = 3_000;
// settle은 durability checkpoint라 FCM 발송 직후에 반드시 기록되어야 한다 — deadline이 임박해도
// 최소 예산(2s)은 확보해 abort로 checkpoint를 잃지(=다음 tick 재발송) 않게 한다.
const SETTLE_MIN_MS = 2_000;

/** RPC abort 예산(ms). deadline 초과면 throw — claim/due는 아직 FCM 발송 전이라 안전. */
function remainingMs(deadlineAtMs: number, operation: string): number {
  const remaining = deadlineAtMs - Date.now();
  if (remaining <= 0) throw new Error(`${operation}: deadline_exceeded`);
  return remaining;
}

function toClaimedRows(data: unknown): ClaimedRow[] {
  const rows: ClaimedRow[] = [];
  for (const raw of (data as unknown[] | null) ?? []) {
    const r = raw as {
      token_id?: number;
      token_hash?: string;
      fcm_token?: string;
      platform?: string | null;
      app_build?: number | null;
    };
    if (r.token_id != null && r.token_hash && r.fcm_token) {
      rows.push({
        token_id: r.token_id,
        token_hash: r.token_hash,
        fcm_token: r.fcm_token,
        platform: r.platform ?? null,
        app_build: r.app_build ?? null,
      });
    }
  }
  return rows;
}

/** 한 버킷(claimed 부분집합)의 FCM 결과를 token별 durable 상태로 settle. accepted 수 반환. */
async function settleBucket(
  bucket: ClaimedRow[],
  res: SendResult,
  leaseToken: string,
  attemptDeadlineAtMs: number,
): Promise<number> {
  if (bucket.length === 0) return 0;
  const settlements = mapHighlightSettlements(
    bucket.map((c) => ({ tokenId: c.token_id, tokenHash: c.token_hash, fcmToken: c.fcm_token })),
    res.outcomes ?? [],
    res.lastError ?? null,
  );
  // settle은 durability checkpoint라 abort 예산을 lease 내 attempt 마감까지 주되 최소(2s)는 확보해
  // FCM 발송 후 checkpoint를 잃지 않는다(HTTP는 lease보다 짧게 abort → lease 초과 재claim 창 제거).
  const settleTimeoutMs = Math.max(SETTLE_MIN_MS, attemptDeadlineAtMs - Date.now());
  // query-guard: bounded -- settle는 claim 배치(최대 500 토큰)의 결과만 단일 RPC로 처리한다.
  const { data: accepted, error } = await supabase
    .rpc("settle_game_event_tokens", {
      p_results: settlements,
      p_lease_token: leaseToken,
    })
    .abortSignal(AbortSignal.timeout(settleTimeoutMs));
  if (error) throw new Error(`game_event token settle: ${error.message}`);
  return Number(accepted ?? 0);
}

/**
 * claimed 배치를 버전 게이트 2버킷으로 나눠 각 버킷 send 직후 settle(NO-GO #2 checkpoint).
 * nExpiresAtMs가 없으면 fail-closed로 claimed 전량을 notification-only 1버킷으로 보낸다.
 */
async function sendAndSettleBuckets(
  claimed: ClaimedRow[],
  d: ScoreFamilyDelivery,
  nExpiresAtMs: number | null,
  leaseToken: string,
  attemptDeadlineAtMs: number,
): Promise<number> {
  // 두 버킷 모두 하나의 attempt 마감(=lease보다 짧음)을 공유한다 — bucket2에 새 8초 예산을 주지
  // 않아 한 claim(=한 lease)의 전체 send가 lease 안에 끝난다(NO-GO #2 lease 중복 창 제거).
  const transportDeadlineAtMs = Math.min(
    attemptDeadlineAtMs - SETTLE_RESERVE_MS,
    Date.now() + TRANSPORT_BUDGET_MS,
  );
  const notification = { title: d.title, body: d.body, url: d.url };

  // fail-closed: 안정 n_expires_at 없음 → data-only 미첨부, 전량 notification-only 1버킷.
  if (nExpiresAtMs == null) {
    const res = await sendFcmToTokens(
      claimed.map((c) => c.fcm_token),
      notification,
      { deadlineAtMs: transportDeadlineAtMs },
    );
    return settleBucket(claimed, res, leaseToken, attemptDeadlineAtMs);
  }

  const byToken = new Map(claimed.map((c) => [c.fcm_token, c]));
  const metas: TokenMeta[] = claimed.map((c) => ({
    fcmToken: c.fcm_token,
    platform: c.platform,
    appBuild: c.app_build,
  }));
  // 실 production 빌더(composeGameEventFanout)로 버킷 분할 + payload를 만든다(smoke와 동일 seam).
  const plan = composeGameEventFanout(
    metas,
    notification,
    {
      gameId: d.gameId,
      eventId: d.eventId,
      sub: d.sub,
      title: d.title,
      body: d.body,
      url: d.url,
      nExpiresAtMs,
    },
    Date.now(),
    Date.now(),
  );

  let accepted = 0;
  // 버킷1(notification: iOS/구Android) — send 직후 settle. 여기서 crash해도 버킷2는 leased로 남아
  // 재claim되고, settle된 버킷1 accepted 토큰은 재발송되지 않는다.
  if (plan.notificationTokens.length > 0) {
    const res = await sendFcmToTokens(plan.notificationTokens, plan.notificationPayload, {
      deadlineAtMs: transportDeadlineAtMs,
    });
    accepted += await settleBucket(
      plan.notificationTokens.map((t) => byToken.get(t)).filter((c): c is ClaimedRow => c != null),
      res,
      leaseToken,
      attemptDeadlineAtMs,
    );
  }
  // 버킷2(data-only: 신Android). deadline_at == n_expires_at 불변식상 claim 시점에 미만료라
  // plan.dataOnlyExpired는 여기서 발생하지 않는다(만료분은 claim RPC가 expired로 이미 제외).
  if (plan.dataOnlyTokens.length > 0) {
    const res = await sendFcmToTokens(plan.dataOnlyTokens, plan.dataOnlyPayload, {
      deadlineAtMs: transportDeadlineAtMs,
    });
    accepted += await settleBucket(
      plan.dataOnlyTokens.map((t) => byToken.get(t)).filter((c): c is ClaimedRow => c != null),
      res,
      leaseToken,
      attemptDeadlineAtMs,
    );
  }
  return accepted;
}

/**
 * 한 score-family 이벤트를 durable token 원장으로 발송한다. 최초 호출이 팀팬 audience를 freeze하고,
 * claimable(waiting/transient/lease-expired) 토큰만 claim→버킷 send→settle한다. accepted 반환.
 * 재발송 판정은 전적으로 token settle 상태 기준(NO-GO #1) — 호출부의 event-global unclaim은 폐기.
 */
export async function deliverScoreFamilyEvent(
  d: ScoreFamilyDelivery,
): Promise<{ accepted: number }> {
  const nExpiresAtMs = deriveGameEventExpiresAtMsOrNull(d.sourceEpochMs);
  const sourceTsIso = Number.isFinite(d.sourceEpochMs)
    ? new Date(d.sourceEpochMs).toISOString()
    : null;

  let accepted = 0;
  for (let i = 0; i < MAX_CLAIM_ITERATIONS; i += 1) {
    if (d.deadlineAtMs != null && Date.now() >= d.deadlineAtMs) break;
    // attempt 마감 = request deadline과 lease보다 짧은 ATTEMPT_BUDGET 중 이른 것.
    // 이 마감에 claim/send/settle를 모두 결속해 lease(20s) 초과 응답을 원차 차단한다.
    const attemptDeadlineAtMs = Math.min(
      d.deadlineAtMs ?? Date.now() + ATTEMPT_BUDGET_MS,
      Date.now() + ATTEMPT_BUDGET_MS,
    );
    const leaseToken = randomUUID();
    // query-guard: bounded -- claim RPC가 반환 배치를 p_limit(최대 500)로 clamp한다.
    // abortSignal: never-settle claim이 lease(20s)를 넘기기 전 attempt 마감에 abort해,
    // lease 초과 응답이 다른 worker 재claim과 겹치는 중복 발송 창을 없앱다(NO-GO #2).
    const { data, error } = await supabase
      .rpc("claim_game_event_tokens", {
        p_event_id: d.eventId,
        p_game_id: d.gameId,
        p_sub: d.sub,
        p_team_id: d.teamId,
        p_pref_key: d.prefKey,
        p_push_title: d.title,
        p_push_body: d.body,
        p_push_url: d.url,
        p_source_ts: sourceTsIso,
        p_lease_token: leaseToken,
        p_lease_seconds: CLAIM_LEASE_SECONDS,
        p_limit: CLAIM_BATCH,
      })
      .abortSignal(AbortSignal.timeout(remainingMs(attemptDeadlineAtMs, "game_event token claim")));
    if (error) throw new Error(`game_event token claim: ${error.message}`);
    const claimed = toClaimedRows(data);
    if (claimed.length === 0) break;
    accepted += await sendAndSettleBuckets(claimed, d, nExpiresAtMs, leaseToken, attemptDeadlineAtMs);
    if (claimed.length < CLAIM_BATCH) break;
  }
  return { accepted };
}

/**
 * source(경기 feed) 소멸 뒤에도 non-terminal 토큰이 남은 snapshot을 frozen payload로 재개한다.
 * transient 재시도·미시도 drain·deadline terminalization을 계속하며, accepted 토큰은 재발송 0.
 */
export async function drainDueScoreFamilyEvents(
  opts?: { deadlineAtMs?: number },
): Promise<{ accepted: number }> {
  // abortSignal: due-list도 request deadline·ATTEMPT_BUDGET 중 이른 마감에 abort해 hung DB 응답을 원차 차단.
  const dueDeadlineAtMs = Math.min(
    opts?.deadlineAtMs ?? Date.now() + ATTEMPT_BUDGET_MS,
    Date.now() + ATTEMPT_BUDGET_MS,
  );
  // query-guard: bounded -- RPC가 due snapshot을 최대 50개(p_limit)로 clamp한다.
  const { data, error } = await supabase
    .rpc("list_due_game_event_snapshots", { p_limit: 50 })
    .abortSignal(AbortSignal.timeout(remainingMs(dueDeadlineAtMs, "game_event due snapshots")));
  if (error) throw new Error(`game_event due snapshots: ${error.message}`);

  type DueRow = {
    event_id: string;
    game_id: string;
    sub: ScoreFamilySub;
    pref_key: ScoreFamilyPref;
    team_id: number;
    push_title: string;
    push_body: string;
    push_url: string;
    source_ts: string | null;
  };

  let accepted = 0;
  for (const raw of (data as DueRow[] | null) ?? []) {
    if (opts?.deadlineAtMs != null && Date.now() >= opts.deadlineAtMs) break;
    const r = await deliverScoreFamilyEvent({
      eventId: raw.event_id,
      gameId: raw.game_id,
      sub: raw.sub,
      prefKey: raw.pref_key,
      teamId: raw.team_id,
      title: raw.push_title,
      body: raw.push_body,
      url: raw.push_url,
      // fail-closed(NO-GO #2): source_ts null/파싱불가면 NaN → notification-only(now 재계산 안 함).
      sourceEpochMs: raw.source_ts ? Date.parse(raw.source_ts) : Number.NaN,
      deadlineAtMs: opts?.deadlineAtMs,
    });
    accepted += r.accepted;
  }
  return { accepted };
}
