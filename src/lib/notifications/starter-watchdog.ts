/**
 * 예고선발 공개 알림 watchdog 오케스트레이터 — 라인업 확정 watchdog(#952, 삼순 8차 GO 규율)의 클론.
 *
 * 라인업 watchdog 과의 차이
 * - 별도 probe 엔드포인트가 없다: 선발 신호(awayStarterName/homeStarterName)는 KBO 공식 응답에
 *   이미 들어 있다. 게이트는 순수 함수 bothStartersOfficial(양팀 모두 공식값) — 한쪽만 공개면 대기.
 * - fetch 는 definitive source 인 fetchKboGamesOnly 를 쓴다(fetchGames 금지): fetchGames 의 Naver
 *   fallback 은 선발명을 항상 빈 문자열로 만들어, KBO 장애를 '선발 미공개 정상(ok)'으로 오인하게
 *   만든다. KBO 실패는 그대로 throw → fetchFailures → systemic failed 로 노출되고 전이 판정은 보류된다.
 * - '전이'는 실제 빈값 관측 이력이 있어야 성립(observe 원장 + shouldEmitStarterAnnounce 게이트):
 *   배포/rollout 첫 tick 에 이미 공식값인 경기는 baseline 기록만 하고 발송하지 않는다(stale burst 차단).
 * - 이미 종결된 (game,team)은 snapshot RPC 가 null 을 반환 → drain/finalize 없이 완전히 skip.
 * - KBO 예고선발은 연전 첫날 시리즈 전체(D+1·D+2 포함)가 공시될 수 있어 여러 날짜를 훑는다
 *   (dateStrs 배열). '연전 첫날' 하드코딩 없음 — 어느 날짜든 빈값→공식값 전이 자체가 트리거.
 * - 재수집/cron 중복 실행의 단일 전이 보장은 DB 원장(game_starter_notify_state)이 담당한다.
 *
 * 유지하는 규율(라인업 watchdog 과 동일)
 * - 감지·open·drain 격리 병렬 + absolute deadline self-abort. snapshot 은 cheap·durable.
 * - due-ledger drainer: 지난 tick 에 열렸다가 못 보낸 원장을 현재 KBO 상태와 무관하게 이어 drain.
 * - systemic 실패 전면 노출: fetch 실패·snapshot 실패·drain 실패·pending·permanent·expired·
 *   openUnresolved 전부 status='failed' 로 route 가 non-2xx 노출. budgetSkipped sentinel 은
 *   informative counters 를 덮지 않는다.
 */
import type { KboGame } from "@/lib/crawler/kbo-api";
// definitive source: Naver fallback 없는 KBO 단독 fetch. fetchGames 는 선발 신호가 없는 Naver 로
// 조용히 대체돼 KBO 장애를 '미공개 정상'으로 오인하게 하므로 여기서 쓰면 안 된다.
import { fetchKboGamesOnly as realFetchGames } from "@/lib/crawler/kbo-api";
import { fetchNaverGames as realFetchScheduleWitness } from "@/lib/crawler/naver-games";
import {
  observeStarterAnnounceGames as realObserveGames,
  openStarterSnapshot as realOpenSnapshot,
  deliverStarterBatch as realDeliverBatch,
  finalizeStarterSnapshot as realFinalizeSnapshot,
  listDueStarterSnapshots as realListDueSnapshots,
  STARTER_DELIVERY_ATTEMPT_MS,
  type StarterDeliveryBatchResult,
  type StarterDeliveryResult,
  type StarterDeliveryTarget,
  type StarterObserveAction,
  type DueStarterSnapshot,
} from "@/lib/notifications/starter-announce-delivery";
import {
  bothStartersOfficial,
  shouldEmitStarterAnnounce,
  formatStarterAnnounceMessage,
} from "@/lib/notifications/starter-announce-message";

export interface StarterWatchdogDeps {
  fetchGames: (dateStr: string) => Promise<KboGame[]>;
  // KBO 200 soft-empty가 정상 무경기인지 열화인지 판별하는 일정 존재 witness.
  // 선발명은 사용하지 않고 경기 존재 여부만 본다.
  fetchScheduleWitness: (dateStr: string) => Promise<KboGame[]>;
  observeGames: (
    observations: Array<{ gameId: string; bothOfficial: boolean }>,
    requestDeadlineAtMs?: number,
  ) => Promise<Map<string, StarterObserveAction>>;
  // null = 이미 종결된 (game,team) — 호출부가 drain/finalize 없이 완전히 skip.
  openSnapshot: (args: StarterDeliveryTarget & { requestDeadlineAtMs?: number }) => Promise<number | null>;
  deliverBatch: (
    args: StarterDeliveryTarget & { snapshotDeadlineAtMs: number; attemptDeadlineAtMs: number },
  ) => Promise<StarterDeliveryBatchResult>;
  finalizeSnapshot: (
    gameId: string,
    teamId: number,
    fcmAcceptedDelta?: number,
    requestDeadlineAtMs?: number,
  ) => Promise<StarterDeliveryResult>;
  listDueSnapshots: (requestDeadlineAtMs?: number) => Promise<DueStarterSnapshot[]>;
  now: () => number;
}

export interface StarterWatchdogSummary {
  dates: number; // 훑은 날짜 수
  fetchFailures: number; // definitive KBO fetch 실패한 날짜 수(부분 소스 열화) = systemic — 전이 판정 보류
  observeErrors: number; // 관측 원장 RPC 실패한 날짜 수 = systemic(전이 판정 불가)
  scheduled: number;
  announced: number; // 양팀 선발 공식값 경기 수
  baselines: number; // rollout 기공개(baseline) 경기 수 — 기록만, 발송 0
  transitions: number; // 실제 빈값→공식값 전이 경기 수(발송 대상)
  completedSkipped: number; // 이미 종결된 (game,team) — snapshot RPC null 로 완전 skip
  targets: number;
  dueSnapshots: number; // 과거 tick 에서 열렸다가 미완료로 남은 due 원장 수
  dueDrained: number; // 이번 tick 에 due-ledger drainer 가 처리한 대상 수
  snapshotsOpened: number;
  snapshotOpenErrors: number;
  snapshotsCompleted: number;
  openUnresolved: number; // open 됐으나 이번 tick 종결 확인 못함 = systemic
  accepted: number;
  drainErrors: number;
  pending: number; // 종료 시점 미terminal(재시도 대기) 행 합계
  permanentFailed: number; // 영구 실패(불량 토큰 등) 합계
  expired: number; // 마감 내 미발송으로 만료된 행 합계(= 실제 놓침, 경보 대상)
}

export interface StarterWatchdogResult {
  status: "ok" | "failed";
  dateStrs: string[];
  summary: StarterWatchdogSummary;
  error?: string;
}

const MAX_BATCHES_PER_TARGET = 8;

/** promise 를 absolute deadline 에 결속. deadline 이 먼저면 reject. */
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

export async function runStarterWatchdog(args: {
  dateStrs: string[];
  deadlineAtMs: number;
  deps?: Partial<StarterWatchdogDeps>;
}): Promise<StarterWatchdogResult> {
  const fetchGames = args.deps?.fetchGames ?? realFetchGames;
  const fetchScheduleWitness = args.deps?.fetchScheduleWitness ?? realFetchScheduleWitness;
  const observeGames = args.deps?.observeGames ?? realObserveGames;
  const openSnapshot = args.deps?.openSnapshot ?? realOpenSnapshot;
  const deliverBatch = args.deps?.deliverBatch ?? realDeliverBatch;
  const finalizeSnapshot = args.deps?.finalizeSnapshot ?? realFinalizeSnapshot;
  const listDueSnapshots = args.deps?.listDueSnapshots ?? realListDueSnapshots;
  const now = args.deps?.now ?? Date.now;
  const { dateStrs, deadlineAtMs } = args;

  const summary: StarterWatchdogSummary = {
    dates: dateStrs.length, fetchFailures: 0, observeErrors: 0, scheduled: 0, announced: 0,
    baselines: 0, transitions: 0, completedSkipped: 0, targets: 0,
    dueSnapshots: 0, dueDrained: 0, snapshotsOpened: 0, snapshotOpenErrors: 0, snapshotsCompleted: 0,
    openUnresolved: 0, accepted: 0, drainErrors: 0, pending: 0, permanentFailed: 0, expired: 0,
  };

  // 이번 tick 에 새로 open 한 (game,team) 키 — due drainer 와 중복 처리 방지.
  const freshKeys = new Set<string>();
  const keyOf = (gameId: string, teamId: number) => `${gameId}:${teamId}`;

  /** (game,team) 원장 drain 루프 + 종료 finalize. 신규/듀 공통. drainErrors·터미널 카운트 집계. */
  const drainTarget = async (
    target: StarterDeliveryTarget,
    snapshotDeadlineAtMs: number,
    countAsDue: boolean,
  ): Promise<void> => {
    let drainThrew = false;
    // 마지막 batch 가 남긴 in-flight 미완료 counters. finalize 미실행/실패 시 보존해 false-green 차단.
    let lastBatchPending = 0;
    let lastBatchPermanent = 0;
    let lastBatchExpired = 0;
    // 이번 tick 에 이 대상을 종결 확인했는가: batch 가 pending=0/claimed=0 를 보았거나 finalize 성공.
    let sawTerminalBatch = false;
    let finalizedOk = false;
    for (let i = 0; i < MAX_BATCHES_PER_TARGET && now() < deadlineAtMs; i++) {
      let batch: StarterDeliveryBatchResult;
      try {
        batch = await deliverBatch({
          ...target,
          snapshotDeadlineAtMs,
          attemptDeadlineAtMs: Math.min(deadlineAtMs, now() + STARTER_DELIVERY_ATTEMPT_MS),
        });
      } catch {
        summary.drainErrors++; // 원장 durable → 다음 cron(또는 due drainer)이 이어 drain. 이 대상만 중단.
        drainThrew = true;
        break;
      }
      // settle 예약분 미달 reserve-skip sentinel: 아무 것도 안 했고 non-terminal.
      // 마지막 informative counters 를 덮지 말고, 종결로도 보지 않는다.
      if (batch.budgetSkipped) break;
      summary.accepted += batch.fcmAcceptedDelta;
      if (batch.snapshotCompleted) summary.snapshotsCompleted++;
      lastBatchPending = batch.pending;
      lastBatchPermanent = batch.permanentFailed;
      lastBatchExpired = batch.expired;
      if (batch.claimed === 0 || batch.pending === 0) { sawTerminalBatch = true; break; }
    }
    if (countAsDue) summary.dueDrained++;
    if (now() < deadlineAtMs) {
      try {
        const fin = await finalizeSnapshot(target.gameId, target.teamId, 0, deadlineAtMs);
        summary.pending += fin.pending;
        summary.permanentFailed += fin.permanentFailed;
        summary.expired += fin.expired;
        finalizedOk = true;
      } catch {
        // finalize 실패(원장 durable) — 마지막 성공 batch 의 terminal counters 전부 보존로 systemic 노출.
        summary.pending += lastBatchPending;
        summary.permanentFailed += lastBatchPermanent;
        summary.expired += lastBatchExpired;
      }
    } else if (!drainThrew) {
      // 예산 소진으로 finalize 미실행: 마지막 batch counters 보존로 false-green 차단.
      summary.pending += lastBatchPending;
      summary.permanentFailed += lastBatchPermanent;
      summary.expired += lastBatchExpired;
    }
    if (!drainThrew && !finalizedOk && !sawTerminalBatch) summary.openUnresolved++;
  };

  /** 신규 announced 대상: openSnapshot(멱등) → drain. 이번 tick 처음 여는 경로. */
  const runNewTargetPipeline = async (game: KboGame, teamId: number) => {
    if (now() >= deadlineAtMs) return;
    freshKeys.add(keyOf(game.gameId, teamId));
    const msg = formatStarterAnnounceMessage({
      teamId,
      awayTeamId: game.awayTeamId,
      homeTeamId: game.homeTeamId,
      awayStarterName: game.awayStarterName,
      homeStarterName: game.homeStarterName,
      gameDate: game.date,
      gameTimeKst: game.time,
    });
    const target: StarterDeliveryTarget = {
      gameId: game.gameId,
      teamId,
      observedAtMs: now(),
      // 선발 정보는 경기 상세 기본(크관) 탭에 노출 — 구버전 앱도 그대로 파싱하는 기존 딥링크 형식.
      payload: { title: msg.title, body: msg.body, url: `/games/${game.gameId}` },
    };
    let snapshotDeadlineAtMs: number | null;
    try {
      snapshotDeadlineAtMs = await openSnapshot({ ...target, requestDeadlineAtMs: deadlineAtMs });
    } catch {
      summary.snapshotOpenErrors++;
      return; // 이 대상만 포기 — 다른 대상 파이프라인은 계속(격리)
    }
    if (snapshotDeadlineAtMs == null) {
      // 이미 종결된 (game,team): drain/finalize 없이 완전 skip — 과거 terminal(permanent/expired)
      // 재집계로 매 tick 반복 502 가 되는 것을 차단한다.
      summary.completedSkipped++;
      return;
    }
    summary.snapshotsOpened++;
    await drainTarget(target, snapshotDeadlineAtMs, false);
  };

  // ── Phase A: 날짜별 fetch → 경기별 게이트 → 두 팀 파이프라인(격리 병렬). ──
  const dateTasks = dateStrs.map(async (dateStr) => {
    if (now() >= deadlineAtMs) return;
    let games: KboGame[];
    try {
      games = await withDeadline(fetchGames(dateStr), deadlineAtMs, `starter fetchGames ${dateStr}`, now);
    } catch {
      summary.fetchFailures++; // 부분 소스 열화 — systemic 노출, 다른 날짜/due drainer 는 계속.
      return;
    }
    // KBO는 HTTP 200 + game:[]로 열화를 숨길 수 있다. Naver 일정은 선발명 source가 아니라
    // 경기 존재 witness로만 사용한다. 양쪽 모두 빈 날만 정상 무경기로 인정한다.
    if (games.length === 0) {
      try {
        const witnessGames = await withDeadline(
          fetchScheduleWitness(dateStr),
          deadlineAtMs,
          `starter schedule witness ${dateStr}`,
          now,
        );
        if (witnessGames.length > 0) {
          summary.fetchFailures++;
          return;
        }
      } catch {
        summary.fetchFailures++;
        return;
      }
    }
    // 미시작(scheduled)만 신규 대상 — cancelled 는 미발송 억제, live/final 은 신규 공개 알림 대상 아님(fail-safe).
    const scheduled = games.filter((g) => g.status === "scheduled");
    summary.scheduled += scheduled.length;
    if (scheduled.length === 0) return;
    // 관측 원장 기록 + 전이 판정: 빈값 관측도 기록해야 이후 공식값이 '실제 전이'로 성립한다.
    // 실패 시 전이 판정 불가 → 이 날짜는 보류하고 systemic 노출(발송 안 함 — stale burst 보다 안전).
    let actions: Map<string, StarterObserveAction>;
    try {
      actions = await observeGames(
        scheduled.map((g) => ({
          gameId: g.gameId,
          bothOfficial: bothStartersOfficial(g.awayStarterName, g.homeStarterName),
        })),
        deadlineAtMs,
      );
    } catch {
      summary.observeErrors++;
      return;
    }
    const gameTasks = scheduled
      .filter((g) => bothStartersOfficial(g.awayStarterName, g.homeStarterName))
      .map(async (game) => {
        summary.announced++;
        const action = actions.get(game.gameId) ?? "wait"; // 판정 누락은 보류(발송 금지)
        if (action === "baseline") summary.baselines++;
        // 실제 빈값→공식값 전이만 발송 — rollout 기공개(baseline)는 기록만 하고 발송 금지.
        // (game,team) 단위 종결/재발송 차단은 snapshot RPC null 반환이 담당(alreadyNotified=false 고정).
        const emit = shouldEmitStarterAnnounce({
          bothOfficial: true,
          alreadyNotified: false,
          sawUnannouncedBefore: action === "emit",
        });
        if (!emit) return;
        summary.transitions++;
        summary.targets += 2;
        // 홈/원정 두 팀도 서로 격리 병렬 — 한 팀 hang 이 다른 팀을 안 막음.
        await Promise.allSettled([
          runNewTargetPipeline(game, game.homeTeamId),
          runNewTargetPipeline(game, game.awayTeamId),
        ]);
      });
    await Promise.allSettled(gameTasks);
  });
  await Promise.allSettled(dateTasks);

  // ── Phase B: due-ledger drainer. 현재 KBO/게임 상태와 무관하게 미완료 원장을 이어 drain. ──
  if (now() < deadlineAtMs) {
    let due: DueStarterSnapshot[] = [];
    try {
      due = await listDueSnapshots(deadlineAtMs);
    } catch {
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

  // systemic 실패 판정: 부분 열화·drain 실패·마감 내 미발송까지 전부 non-2xx 노출.
  // '양팀 선발 미공개'는 건강한 신호(announced=0·ok) — 여기 안 걸린다.
  const systemicFail =
    summary.fetchFailures > 0 || // 날짜별 definitive KBO 목록 실패(부분 포함) — Naver fallback 으로 가리지 않음
    summary.observeErrors > 0 || // 관측 원장 실패 — 전이 판정 불가(보류)
    summary.snapshotOpenErrors > 0 || // 원장 생성 실패(부분 포함)
    summary.drainErrors > 0 || // drain/FCM/due 조회 실패
    summary.pending > 0 || // FCM transient 로 미완료(부분 FCM 실패)
    summary.permanentFailed > 0 || // 영구 실패(불량 토큰 등) = 부분 delivery 실패
    summary.openUnresolved > 0 || // open 됐으나 이번 tick 미종결(deadline 소진)
    summary.expired > 0 || // 마감 내 미발송(실제 놓침) — 경보
    (summary.targets > 0 && summary.snapshotsOpened === 0 && summary.completedSkipped === 0);

  return { status: systemicFail ? "failed" : "ok", dateStrs, summary };
}
