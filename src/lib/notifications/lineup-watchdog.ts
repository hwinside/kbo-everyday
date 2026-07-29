/**
 * 라인업 확정 알림 watchdog 오케스트레이터 (삼순 #952 NO-GO 1·2차 반영).
 *
 * 설계 원칙
 * - 감지·open·drain 모두 **격리된 병렬 파이프라인**(game-status runGamePipeline 패턴). 한 대상의
 *   느린 KBO/DB/FCM 이 다른 대상을 굶기지 않는다(공유 join 지점 없음, 각자 deadline 으로 self-abort).
 * - snapshot 은 cheap·durable. 이번 tick 에 못 보낸 대상은 원장이 남아 다음 cron 이 이어 보낸다.
 * - false-green 차단(gate ①): (a) KBO 목록 실패 (b) 라인업 조회 전건이 정의적 신호(true/false) 0건
 *   (=all-null/all-throw: 엔드포인트 열화) (c) 확정 대상이 있는데 snapshot RPC 가 하나라도 실패
 *   → status='failed' 로 route 가 non-2xx 노출. (b)는 정상 미확정(LINEUP_CK=false)과 구분된다:
 *   건강한 미확정은 `false` 신호를 주므로 signalCount>0 → ok.
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
  lineupProbes: number;
  lineupSignals: number; // 정의적 true/false 신호 수(엔드포인트 건강 지표)
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

const MAX_BATCHES_PER_TARGET = 8;

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
    scheduled: 0, lineupProbes: 0, lineupSignals: 0, confirmed: 0, targets: 0,
    snapshotsOpened: 0, snapshotOpenErrors: 0, snapshotsCompleted: 0, accepted: 0, drainErrors: 0,
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

  // ── Phase 0: 확정 감지 — 병렬 격리(각 probe 는 자체 timeoutMs). null/throw = 신호 없음. ──
  const probes = await Promise.all(
    scheduled.map(async (game) => {
      if (now() >= deadlineAtMs) return { game, ck: null as boolean | null };
      try {
        return { game, ck: await fetchLineupConfirmed(game.gameId, { timeoutMs: lineupFetchMs }) };
      } catch {
        return { game, ck: null as boolean | null };
      }
    }),
  );
  summary.lineupProbes = scheduled.length;
  const targets: Array<{ gameId: string; teamId: number; gameTimeKst: string }> = [];
  for (const p of probes) {
    if (p.ck === true || p.ck === false) summary.lineupSignals++;
    if (p.ck === true) {
      summary.confirmed++;
      targets.push({ gameId: p.game.gameId, teamId: p.game.homeTeamId, gameTimeKst: p.game.time });
      targets.push({ gameId: p.game.gameId, teamId: p.game.awayTeamId, gameTimeKst: p.game.time });
    }
  }
  summary.targets = targets.length;

  // false-green 차단(gate ①-b): scheduled 경기가 있는데 정의적 신호가 0건 = 엔드포인트 열화(all-null/throw).
  // 건강한 미확정은 LINEUP_CK=false 신호를 주므로 signalCount>0 → 여기 안 걸림.
  const allProbesNoSignal = summary.lineupProbes > 0 && summary.lineupSignals === 0;

  // ── Phase 1+2: 대상별 격리 파이프라인(open→drain) 병렬. 한 대상의 hang/실패가 다른 대상을 안 굶김. ──
  const runTargetPipeline = async (t: { gameId: string; teamId: number; gameTimeKst: string }) => {
    if (now() >= deadlineAtMs) return;
    const msg = formatLineupConfirmMessage({ teamId: t.teamId, confirmedAt: new Date(now()), gameTimeKst: t.gameTimeKst });
    const target: LineupDeliveryTarget = {
      gameId: t.gameId,
      teamId: t.teamId,
      observedAtMs: now(),
      payload: { title: msg.title, body: msg.body, url: `/games/${t.gameId}?tab=lineup` },
    };
    let snapshotDeadlineAtMs: number;
    try {
      snapshotDeadlineAtMs = await openSnapshot({ ...target, requestDeadlineAtMs: deadlineAtMs });
      summary.snapshotsOpened++;
    } catch {
      summary.snapshotOpenErrors++;
      return; // 이 대상만 포기 — 다른 대상 파이프라인은 계속(격리)
    }
    for (let i = 0; i < MAX_BATCHES_PER_TARGET && now() < deadlineAtMs; i++) {
      let batch: LineupDeliveryBatchResult;
      try {
        batch = await deliverBatch({
          ...target,
          snapshotDeadlineAtMs,
          attemptDeadlineAtMs: Math.min(deadlineAtMs, now() + LINEUP_DELIVERY_ATTEMPT_MS),
        });
      } catch {
        summary.drainErrors++; // 원장 durable → 다음 cron 이 이어 drain. 이 대상만 중단.
        return;
      }
      summary.accepted += batch.fcmAcceptedDelta;
      if (batch.snapshotCompleted) summary.snapshotsCompleted++;
      if (batch.claimed === 0 || batch.pending === 0) break;
    }
  };

  // 모든 대상 파이프라인을 동시에 — 공유 join 없음. 하나가 deadline 까지 hang(→RPC abort reject)해도
  // 나머지는 완주한다. allSettled 로 한 rejection 이 전체를 무너뜨리지 않게 감싼다.
  await Promise.allSettled(targets.map((t) => runTargetPipeline(t)));

  const systemicFail =
    allProbesNoSignal || // (b) 라인업 신호 전무
    summary.snapshotOpenErrors > 0 || // (c) 원장 생성 실패(부분 포함) = durable health 불량
    (targets.length > 0 && summary.snapshotsOpened === 0);

  return { status: systemicFail ? "failed" : "ok", dateStr, summary };
}
