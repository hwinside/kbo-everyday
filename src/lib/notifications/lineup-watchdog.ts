/**
 * 라인업 확정 알림 watchdog 오케스트레이터 (삼순 #952 NO-GO 1·2·3차 반영).
 *
 * 설계 원칙
 * - 감지·open·drain 모두 **격리된 병렬 파이프라인**. 한 대상의 느린 KBO/DB/FCM 이 다른 대상을 굶기지
 *   않는다(공유 join 지점 없음, 각자 absolute deadline 으로 self-abort).
 * - Phase 0 공유 barrier 제거(3차 re-gate ①): game probe 결과가 나오는 즉시 그 game 의 pipeline 을
 *   시작한다. 느린 probe 하나가 이미 확정된 다른 game 의 발송을 지연시키지 않는다. fetchGames·probe·
 *   RPC·FCM 전부 동일 absolute deadline(deadlineAtMs)에 결속된다.
 * - snapshot 은 cheap·durable. 이번 tick 에 못 보낸 대상은 원장이 남고, 다음 cron 의 **due-ledger
 *   drainer**(3차 re-gate ③)가 현재 KBO/게임 상태와 무관하게 이어 보낸다. 라인업 확정 후 경기가 live 로
 *   전환돼도 원장이 orphan 으로 방치되지 않는다(deadline 안이면 재시도, 초과면 finalize 가 expire).
 * - systemic 실패 전면 노출(3차 re-gate ②): KBO 목록 실패, 라인업 신호 전무(all-null/throw), 부분 probe
 *   null(특정 game 열화), snapshot RPC 실패, drain 실패, expired(마감 내 미발송)를 status='failed' 로
 *   route 가 non-2xx 노출한다. 건강한 미확정(LINEUP_CK=false)은 `false` 신호이므로 여기 안 걸린다.
 */
import type { KboGame } from "@/lib/crawler/kbo-api";
import { fetchGames as realFetchGames } from "@/lib/crawler/kbo-api";
import { fetchLineupConfirmed as realFetchLineupConfirmed } from "@/lib/crawler/lineup-confirmed";
import {
  openLineupSnapshot as realOpenSnapshot,
  deliverLineupBatch as realDeliverBatch,
  finalizeLineupSnapshot as realFinalizeSnapshot,
  listDueLineupSnapshots as realListDueSnapshots,
  LINEUP_DELIVERY_ATTEMPT_MS,
  type LineupDeliveryBatchResult,
  type LineupDeliveryResult,
  type LineupDeliveryTarget,
  type DueLineupSnapshot,
} from "@/lib/notifications/lineup-confirm-delivery";
import { formatLineupConfirmMessage } from "@/lib/notifications/lineup-confirm-message";

export interface LineupWatchdogDeps {
  fetchGames: (dateStr: string) => Promise<KboGame[]>;
  fetchLineupConfirmed: (gameId: string, opts?: { timeoutMs?: number }) => Promise<boolean | null>;
  openSnapshot: (args: LineupDeliveryTarget & { requestDeadlineAtMs?: number }) => Promise<number>;
  deliverBatch: (
    args: LineupDeliveryTarget & { snapshotDeadlineAtMs: number; attemptDeadlineAtMs: number },
  ) => Promise<LineupDeliveryBatchResult>;
  finalizeSnapshot: (
    gameId: string,
    teamId: number,
    fcmAcceptedDelta?: number,
    requestDeadlineAtMs?: number,
  ) => Promise<LineupDeliveryResult>;
  listDueSnapshots: (requestDeadlineAtMs?: number) => Promise<DueLineupSnapshot[]>;
  now: () => number;
}

export interface LineupWatchdogSummary {
  scheduled: number;
  lineupProbes: number;
  lineupSignals: number; // 정의적 true/false 신호 수(엔드포인트 건강 지표)
  probeFailures: number; // probe 가 null(throw/열화/deadline-skip) 반환 = 부분 소스 열화
  confirmed: number;
  targets: number;
  dueSnapshots: number; // 과거 tick 에서 열렸다가 미완료로 남은 due 원장 수
  dueDrained: number; // 이번 tick 에 due-ledger drainer 가 처리한 대상 수
  snapshotsOpened: number;
  snapshotOpenErrors: number;
  snapshotsCompleted: number;
  snapshotsPartial: number; // accepted 일부 + permanent/expired 일부인 terminal 대상
  snapshotsFailed: number; // accepted 0 + permanent/expired인 terminal 대상
  openUnresolved: number; // open 됐으나 이번 tick 종결 확인 못함(deadline 소진로 drain/finalize 미수행) = systemic
  accepted: number;
  drainErrors: number;
  pending: number; // 종료 시점 미terminal(재시도 대기) 행 합계
  permanentFailed: number; // 영구 실패(불량 토큰 등) 합계
  expired: number; // 마감 내 미발송으로 만료된 행 합계(= 실제 놓침, 경보 대상)
}

export interface LineupWatchdogResult {
  status: "ok" | "failed";
  dateStr: string;
  summary: LineupWatchdogSummary;
  error?: string;
}

const MAX_BATCHES_PER_TARGET = 8;

/** promise 를 absolute deadline 에 결속. deadline 이 먼저면 reject(공유 배리어 없이 fetchGames 도 결속). */
function withDeadline<T>(p: Promise<T>, deadlineAtMs: number, label: string, now: () => number): Promise<T> {
  const remaining = deadlineAtMs - now();
  if (remaining <= 0) return Promise.reject(new Error(`${label}: deadline_exceeded`));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: deadline_exceeded`)), remaining);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
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
  const finalizeSnapshot = args.deps?.finalizeSnapshot ?? realFinalizeSnapshot;
  const listDueSnapshots = args.deps?.listDueSnapshots ?? realListDueSnapshots;
  const now = args.deps?.now ?? Date.now;
  const { dateStr, deadlineAtMs } = args;
  const lineupFetchMs = args.lineupFetchMs ?? 3_000;

  const summary: LineupWatchdogSummary = {
    scheduled: 0, lineupProbes: 0, lineupSignals: 0, probeFailures: 0, confirmed: 0, targets: 0,
    dueSnapshots: 0, dueDrained: 0, snapshotsOpened: 0, snapshotOpenErrors: 0, snapshotsCompleted: 0,
    snapshotsPartial: 0, snapshotsFailed: 0,
    openUnresolved: 0, accepted: 0, drainErrors: 0, pending: 0, permanentFailed: 0, expired: 0,
  };

  // fetchGames 도 동일 absolute deadline 에 결속(re-gate ①). 실패/초과면 systemic failed.
  let games: KboGame[];
  try {
    games = await withDeadline(fetchGames(dateStr), deadlineAtMs, "lineup fetchGames", now);
  } catch (e) {
    return { status: "failed", dateStr, summary, error: e instanceof Error ? e.message : String(e) };
  }

  // 미시작(scheduled)만 신규 감지 대상 — live/final/cancelled 는 신규 확정 알림 대상 아님(fail-safe, gate ②).
  const scheduled = games.filter((g) => g.status === "scheduled");
  summary.scheduled = scheduled.length;

  // 이번 tick 에 새로 open 한 (game,team) 키 — due drainer 와 중복 처리 방지.
  const freshKeys = new Set<string>();
  const keyOf = (gameId: string, teamId: number) => `${gameId}:${teamId}`;

  /** (game,team) 원장 drain 루프 + 종료 finalize. 신규/듀 공통. drainErrors·터미널 카운트 집계. */
  const drainTarget = async (
    target: LineupDeliveryTarget,
    snapshotDeadlineAtMs: number,
    countAsDue: boolean,
  ): Promise<void> => {
    let drainThrew = false;
    // 마지막 batch 가 남긴 in-flight 미완료 pending. deadline 소진으로 finalize 미실행 시 보존해
    // false-green(status:ok·pending:0) 차단(삼순 #952 5차 blocker).
    let lastBatchPending = 0;
    let lastBatchPermanent = 0;
    let lastBatchExpired = 0;
    // 이번 tick 에 이 대상을 종결 확인했는가: batch 가 pending=0/claimed=0 를 보았거나 finalize 성공.
    // 둘 다 아니면(deadline 소진로 drain/finalize 미수행) open 했지만 미종결 → systemic(삼순 #952 6차 ①).
    let sawTerminalBatch = false;
    let finalizedOk = false;
    for (let i = 0; i < MAX_BATCHES_PER_TARGET && now() < deadlineAtMs; i++) {
      let batch: LineupDeliveryBatchResult;
      try {
        batch = await deliverBatch({
          ...target,
          snapshotDeadlineAtMs,
          attemptDeadlineAtMs: Math.min(deadlineAtMs, now() + LINEUP_DELIVERY_ATTEMPT_MS),
        });
      } catch {
        summary.drainErrors++; // 원장 durable → 다음 cron(또는 due drainer)이 이어 drain. 이 대상만 중단.
        drainThrew = true;
        break;
      }
      // settle 예약분 미달로 아예 시작 못한 reserve-skip sentinel: 아무 것도 안 했고 non-terminal.
      // 마지막 informative counters(pending/permanent/expired)를 덮지 말고, 종결로도 보지 않는다.
      // → 뒤 finalize(성공 시 authoritative) 또는 fallback(보존된 counters)이 systemic 노출(삼순 #952 7차).
      if (batch.budgetSkipped) break;
      summary.accepted += batch.fcmAcceptedDelta;
      if (batch.snapshotCompleted) summary.snapshotsCompleted++;
      lastBatchPending = batch.pending; // finalize throw/skip 시 systemic 보존용(삼순 5·7차)
      lastBatchPermanent = batch.permanentFailed;
      lastBatchExpired = batch.expired;
      if (batch.claimed === 0 || batch.pending === 0) { sawTerminalBatch = true; break; }
    }
    if (countAsDue) summary.dueDrained++;
    // 종료 시점 터미널 카운트 확정(pending/permanent/expired). deadline 초과 pending 은 여기서 expired 전환.
    // drain 이 throw 로 끊겼거나 예산 초과면 finalize 도 못 돌 수 있으니 best-effort(실패는 무시, 원장 durable).
    if (now() < deadlineAtMs) {
      try {
        const fin = await finalizeSnapshot(target.gameId, target.teamId, 0, deadlineAtMs);
        summary.pending += fin.pending;
        summary.permanentFailed += fin.permanentFailed;
        summary.expired += fin.expired;
        if (fin.deliveryStatus === "partial") summary.snapshotsPartial++;
        if (fin.deliveryStatus === "failed") summary.snapshotsFailed++;
        finalizedOk = true; // finalize 성공 = 이 대상 이번 tick 종결 확정(pending/permanent/expired 확정).
      } catch {
        // finalize 실패(원장 durable) — 마지막 성공 batch 의 terminal counters 전부 보존로 systemic 노출
        // (삼순 #952 7차: batch permanent>0 + finalize throw 결합 유실 차단).
        summary.pending += lastBatchPending;
        summary.permanentFailed += lastBatchPermanent;
        summary.expired += lastBatchExpired;
      }
    } else if (!drainThrew) {
      // 예산 소진으로 finalize 를 못 돌린 경우: 미완료는 pending 으로 최소 계상(durable, 다음 tick 재drain).
      // 예산 소진으로 finalize 미실행(삼순 #952 5차): 마지막 batch 미완료 pending 보존로 false-green 차단.
      summary.pending += lastBatchPending;
      summary.permanentFailed += lastBatchPermanent;
      summary.expired += lastBatchExpired;
    }
    // open 됐지만 이번 tick 종결(pending=0 확인 또는 finalize 성공)을 못 한 대상은 systemic 노출
    // (삼순 #952 6차 ①: snapshot open 직후 deadline 으로 batch 0회·finalize skip 캐이스). throw 는
    // 이미 drainErrors>0 로 노출되므로 중복 계상하지 않는다.
    if (!drainThrew && !finalizedOk && !sawTerminalBatch) summary.openUnresolved++;
  };

  /** 신규 confirmed 대상: openSnapshot(멱등) → drain. 이번 tick 처음 여는 경로. */
  const runNewTargetPipeline = async (t: { gameId: string; teamId: number; gameTimeKst: string }) => {
    if (now() >= deadlineAtMs) return;
    freshKeys.add(keyOf(t.gameId, t.teamId));
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
    await drainTarget(target, snapshotDeadlineAtMs, false);
  };

  // ── Phase A: game 별 probe→pipeline 융합(공유 barrier 제거). probe 즉시 그 game 의 두 팀 파이프라인 시작. ──
  const gameTasks = scheduled.map(async (game) => {
    if (now() >= deadlineAtMs) return;
    // probe timeout 도 absolute deadline 에 clamp — 느린 probe 가 전체 예산을 넘기지 않게.
    const probeBudget = Math.max(1, Math.min(lineupFetchMs, deadlineAtMs - now()));
    let ck: boolean | null;
    try {
      ck = await fetchLineupConfirmed(game.gameId, { timeoutMs: probeBudget });
    } catch {
      ck = null;
    }
    summary.lineupProbes++;
    if (ck === true || ck === false) summary.lineupSignals++;
    else summary.probeFailures++; // null = throw/열화/deadline-skip → 부분 소스 열화 신호(re-gate ②)
    if (ck !== true) return;
    summary.confirmed++;
    summary.targets += 2;
    // 홈/원정 두 팀도 서로 격리 병렬 — 한 팀 hang 이 다른 팀을 안 막음.
    await Promise.allSettled([
      runNewTargetPipeline({ gameId: game.gameId, teamId: game.homeTeamId, gameTimeKst: game.time }),
      runNewTargetPipeline({ gameId: game.gameId, teamId: game.awayTeamId, gameTimeKst: game.time }),
    ]);
  });
  await Promise.allSettled(gameTasks);

  // false-green 차단(gate ①-b): scheduled 경기가 있는데 정의적 신호가 0건 = 엔드포인트 열화(all-null/throw).
  const allProbesNoSignal = summary.lineupProbes > 0 && summary.lineupSignals === 0;

  // ── Phase B: due-ledger drainer(re-gate ③). 현재 KBO/게임 상태와 무관하게 미완료 원장을 이어 drain. ──
  // 이번 tick freshKeys 에서 이미 처리한 (game,team)은 제외(중복 방지). 나머지는 deadline 안이면 재시도,
  // 초과면 drainTarget 안의 finalize 가 expire+카운트(늦은 발송은 claim 의 deadline_at>now 필터가 원천 차단).
  if (now() < deadlineAtMs) {
    let due: DueLineupSnapshot[] = [];
    try {
      due = await listDueSnapshots(deadlineAtMs);
    } catch {
      // due 조회 실패도 열화 — drainError 로 계상해 systemic 노출.
      summary.drainErrors++;
      due = [];
    }
    summary.dueSnapshots = due.length;
    const dueTasks = due
      .filter((s) => !freshKeys.has(keyOf(s.gameId, s.teamId)))
      .map((s) =>
        drainTarget(
          { gameId: s.gameId, teamId: s.teamId, observedAtMs: now(), payload: s.payload },
          s.snapshotDeadlineAtMs,
          true,
        ),
      );
    await Promise.allSettled(dueTasks);
  }

  // systemic 실패 판정(re-gate ②): 부분 열화·drain 실패·마감 내 미발송까지 전부 non-2xx 노출.
  const systemicFail =
    allProbesNoSignal || // (b) 라인업 신호 전무
    summary.probeFailures > 0 || // 부분 소스 null(특정 game 열화)
    summary.snapshotOpenErrors > 0 || // 원장 생성 실패(부분 포함)
    summary.drainErrors > 0 || // drain/FCM/due 조회 실패
    summary.pending > 0 || // 이번 tick 발송 시도했으나 FCM transient 로 미완료(부분 FCM 실패) — 삼순 #952 4차 blocker2
    summary.permanentFailed > 0 || // 영구 실패(불량 토큰 등) = 부분 delivery 실패 — 삼순 #952 6차 ②
    summary.snapshotsPartial > 0 || // terminal partial을 lineup_notified 성공으로 오판하지 않음
    summary.snapshotsFailed > 0 || // terminal failed를 운영 응답에 보존
    summary.openUnresolved > 0 || // open 됐으나 이번 tick 미종결(deadline 소진) — 삼순 #952 6차 ①
    summary.expired > 0 || // 마감 내 미발송(실제 놓침) — 경보
    (summary.targets > 0 && summary.snapshotsOpened === 0);

  return { status: systemicFail ? "failed" : "ok", dateStr, summary };
}
