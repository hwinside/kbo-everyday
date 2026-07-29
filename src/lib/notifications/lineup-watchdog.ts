/**
 * 라인업 확정 알림 watchdog 오케스트레이터 (삼순 #952 NO-GO 반영).
 *
 * 설계 원칙
 * - snapshot-first: 확정된 모든 (game,team) 대상의 durable 원장을 **먼저 전부 생성**한 뒤 drain 한다.
 *   앞 팀의 느린 FCM drain 이 뒤 팀의 원장 생성을 굶겨 경기 시작 전 미발송되는 것을 막는다(gate ②).
 * - 공정 round-robin drain: 남은 예산 안에서 대상별 1 batch 씩 순회. 원장은 durable 하므로 이번 tick
 *   에 다 못 보내도 다음 cron 이 이어 보낸다.
 * - deadline 전파: 모든 DB RPC 는 잔여 예산으로 abort(delivery 모듈이 담당).
 * - false-green 차단: KBO 목록 실패, 확정 대상이 있는데 원장 0개, 라인업 조회 전건 실패 →
 *   status='failed' 로 반환해 route 가 non-2xx 로 노출한다(gate ①).
 */
import type { KboGame } from "@/lib/crawler/kbo-api";
import { fetchGames as realFetchGames } from "@/lib/crawler/kbo-api";
import { fetchLineupConfirmed as realFetchLineupConfirmed } from "@/lib/crawler/lineup-confirmed";
import {
  openLineupSnapshot as realOpenSnapshot,
  deliverLineupBatch as realDeliverBatch,
  LINEUP_DELIVERY_ATTEMPT_MS,
  type LineupDeliveryBatchResult,
  type LineupDeliveryTarget,
} from "@/lib/notifications/lineup-confirm-delivery";
import { formatLineupConfirmMessage } from "@/lib/notifications/lineup-confirm-message";

export interface LineupWatchdogDeps {
  fetchGames: (dateStr: string) => Promise<KboGame[]>;
  fetchLineupConfirmed: (gameId: string, opts?: { timeoutMs?: number }) => Promise<boolean | null>;
  openSnapshot: (args: LineupDeliveryTarget & { requestDeadlineAtMs?: number }) => Promise<number>;
  deliverBatch: (
    args: LineupDeliveryTarget & { snapshotDeadlineAtMs: number; attemptDeadlineAtMs: number },
  ) => Promise<LineupDeliveryBatchResult>;
  now: () => number;
}

export interface LineupWatchdogSummary {
  scheduled: number;
  confirmed: number;
  targets: number;
  snapshotsOpened: number;
  snapshotOpenErrors: number;
  snapshotsCompleted: number;
  accepted: number;
  drainErrors: number;
}

export interface LineupWatchdogResult {
  status: "ok" | "failed";
  dateStr: string;
  summary: LineupWatchdogSummary;
  error?: string;
}

export async function runLineupWatchdog(args: {
  dateStr: string;
  deadlineAtMs: number;
  lineupFetchMs?: number;
  deps?: Partial<LineupWatchdogDeps>;
}): Promise<LineupWatchdogResult> {
  const fetchGames = args.deps?.fetchGames ?? realFetchGames;
  const fetchLineupConfirmed = args.deps?.fetchLineupConfirmed ?? realFetchLineupConfirmed;
  const openSnapshot = args.deps?.openSnapshot ?? realOpenSnapshot;
  const deliverBatch = args.deps?.deliverBatch ?? realDeliverBatch;
  const now = args.deps?.now ?? Date.now;
  const { dateStr, deadlineAtMs } = args;
  const lineupFetchMs = args.lineupFetchMs ?? 3_000;

  const summary: LineupWatchdogSummary = {
    scheduled: 0, confirmed: 0, targets: 0, snapshotsOpened: 0,
    snapshotOpenErrors: 0, snapshotsCompleted: 0, accepted: 0, drainErrors: 0,
  };

  let games: KboGame[];
  try {
    games = await fetchGames(dateStr);
  } catch (e) {
    return { status: "failed", dateStr, summary, error: e instanceof Error ? e.message : String(e) };
  }

  // 미시작(scheduled)만 — live/final/cancelled 는 라인업 확정 알림 대상 아님(fail-safe, gate ②).
  const scheduled = games.filter((g) => g.status === "scheduled");
  summary.scheduled = scheduled.length;

  // 확정 감지 → 홈/원정 대상 수집.
  const targets: Array<{ gameId: string; teamId: number; gameTimeKst: string }> = [];
  let lineupFetchAttempts = 0;
  let lineupFetchErrors = 0;
  for (const game of scheduled) {
    if (now() >= deadlineAtMs) break;
    lineupFetchAttempts++;
    let confirmed: boolean | null;
    try {
      confirmed = await fetchLineupConfirmed(game.gameId, { timeoutMs: lineupFetchMs });
    } catch {
      lineupFetchErrors++;
      continue;
    }
    if (confirmed !== true) continue;
    summary.confirmed++;
    targets.push({ gameId: game.gameId, teamId: game.homeTeamId, gameTimeKst: game.time });
    targets.push({ gameId: game.gameId, teamId: game.awayTeamId, gameTimeKst: game.time });
  }
  summary.targets = targets.length;

  // ── Phase 1: snapshot-first — 확정 대상 원장을 전부 먼저 생성(cheap·durable) ──
  const opened: Array<{ target: LineupDeliveryTarget; snapshotDeadlineAtMs: number; done: boolean }> = [];
  for (const t of targets) {
    if (now() >= deadlineAtMs) break;
    const msg = formatLineupConfirmMessage({ teamId: t.teamId, confirmedAt: new Date(now()), gameTimeKst: t.gameTimeKst });
    const target: LineupDeliveryTarget = {
      gameId: t.gameId,
      teamId: t.teamId,
      observedAtMs: now(),
      payload: { title: msg.title, body: msg.body, url: `/games/${t.gameId}?tab=lineup` },
    };
    try {
      const snapshotDeadlineAtMs = await openSnapshot({ ...target, requestDeadlineAtMs: deadlineAtMs });
      opened.push({ target, snapshotDeadlineAtMs, done: false });
      summary.snapshotsOpened++;
    } catch {
      summary.snapshotOpenErrors++;
    }
  }

  // ── Phase 2: 공정 round-robin drain — 대상별 1 batch 씩, 예산 안에서 순회 ──
  let progress = true;
  while (progress && now() < deadlineAtMs) {
    progress = false;
    for (const o of opened) {
      if (o.done) continue;
      if (now() >= deadlineAtMs) break;
      try {
        const batch = await deliverBatch({
          ...o.target,
          snapshotDeadlineAtMs: o.snapshotDeadlineAtMs,
          attemptDeadlineAtMs: Math.min(deadlineAtMs, now() + LINEUP_DELIVERY_ATTEMPT_MS),
        });
        summary.accepted += batch.fcmAcceptedDelta;
        if (batch.snapshotCompleted) summary.snapshotsCompleted++;
        if (batch.claimed > 0) progress = true;
        if (batch.pending === 0) o.done = true;
      } catch {
        // 이번 tick 이 대상은 포기(원장 durable → 다음 cron 이 이어 drain).
        summary.drainErrors++;
        o.done = true;
      }
    }
  }

  // false-green 차단(gate ①): 확정 대상 있는데 원장 0개 or 라인업 조회 전건 실패 → systemic failure.
  const systemicFail =
    (targets.length > 0 && summary.snapshotsOpened === 0) ||
    (lineupFetchAttempts > 0 && lineupFetchErrors === lineupFetchAttempts);

  return { status: systemicFail ? "failed" : "ok", dateStr, summary };
}
