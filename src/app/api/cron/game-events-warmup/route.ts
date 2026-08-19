import { NextRequest, NextResponse } from "next/server";
import type { KboRawGame } from "@/types/api";
import type { GameEvent } from "@/types/game-events";
import type { StartPlateAppearanceEvidence } from "@/lib/notifications/start-freshness-policy";
import { fetchInitialGameEventsBounded } from "@/lib/notifications/start-evidence-fetch";
import { notifyGameStatusTransitions } from "@/lib/notifications/game-status";
import { notifyTeamRankChanges } from "@/lib/notifications/team-rank";
import { notifyScoreEvents, notifyInningSummaries } from "@/lib/notifications/game-score";
import { notifyPlayerHighlights } from "@/lib/notifications/player-highlight";
import { pushLiveActivityUpdates, pushLiveActivityStarts, pushLiveActivitySilentWakes } from "@/lib/notifications/live-activity";
import {
  ensureLiveActivityChannels,
  pushLiveActivityChannelBroadcasts,
  snapshotChannelLastStates,
} from "@/lib/notifications/live-activity-channels";
import { pushAndroidWidgetLiveUpdates } from "@/lib/notifications/android-widget-live";
import { pushIosWidgetLiveUpdates } from "@/lib/notifications/ios-widget-live";
import {
  startWidgetRefreshPipelines,
  FAST_LOOP_DEADLINE_MS,
} from "@/lib/notifications/widget-fast-loop";
import { fetchKboLiveGames } from "@/lib/notifications/kbo-live-games";
import {
  startLaOrchestration,
  LA_FANOUT_DRAIN_DEADLINE_MS,
  LA_BROADCAST_DEADLINE_MS,
} from "@/lib/notifications/live-fast-path";
import { reconcileChannelBornFromAcks } from "@/lib/notifications/live-activity-channel-born-reconcile";
import { runBeforeDeadline } from "@/lib/async-deadline";
import { getGameEventsRouteResult } from "@/lib/services/game-events";
import { getGameRelayRouteResult } from "@/lib/services/game-relay";

/**
 * Warm up the in-memory prevState cache of /api/game-events for every
 * currently-live KBO game. Without this, the cache is only populated when
 * a client opens a game page, so any plays that happen between the actual
 * first pitch and the first client visit are emitted as `game_start` only —
 * the BoxScore stat lines accrued in that window never become events.
 *
 * Calls the same shared game-events service used by the route so the warm-up
 * traverses the exact diff path without an extra same-origin invocation.
 */

const CRON_SECRET = process.env.CRON_SECRET || "";
const INITIAL_GAME_EVENTS_TIMEOUT_MS = 3_000;

// Vercel Pro 실행 상한은 300s로 올려 플랫폼 강제절단 여유를 확보한다. 내부 fast-loop/fanout은
// 기존 요청-절대 52s/68s deadline을 그대로 유지해 다음 분 cron과의 겹침을 늘리지 않는다.
// 겹친 invocation의 중복 발송은 DB 선점/CAS/hash dedupe가 차단한다.
export const maxDuration = 300;

function getKSTDateStr(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10).replace(/-/g, "");
}

// 잠금화면 Live Activity "중계 한 줄" 소스 — /api/game-relay 응답에서 최근 플레이 1줄 추출.
// innings는 시간순 오름차순(parseInningRelays), plays도 오름차순 → 마지막 non-empty 이닝의
// 마지막 play = 최신. 예: "안재석 삼진 아웃"(이닝은 상단 LIVE 표기와 중복이라 제외). 실패 시 null(카드 무영향).
type RelayLite = { innings?: { inning: number; half: string; plays?: { batterName: string; result: string }[] }[] };
function latestRelayLine(relay: unknown): string | null {
  const innings = (relay as RelayLite)?.innings;
  if (!Array.isArray(innings)) return null;
  let lastInn: { inning: number; half: string } | null = null;
  let lastPlay: { batterName: string; result: string } | null = null;
  for (const inn of innings) {
    if (inn?.plays && inn.plays.length > 0) {
      lastInn = inn;
      lastPlay = inn.plays[inn.plays.length - 1];
    }
  }
  if (!lastInn || !lastPlay || !lastPlay.batterName || !lastPlay.result) return null;
  // 이닝(N회초/말)은 카드 상단 LIVE 표기와 중복 → 타자 + 결과만 (하린아빠 승인 목업).
  const line = `${lastPlay.batterName} ${lastPlay.result}`;
  return line.length > 40 ? line.slice(0, 39) + "…" : line;
}

export async function GET(req: NextRequest) {
  // 요청 진입 시각 — fast-refresh 루프의 *절대* deadline 기준(삼순 blocker①: warmup 본작업이
  // 지연돼도 +20/+40 tick이 요청 시작 60s를 넘어 다음 크론과 겹치지 않게 여기서 잡는다).
  const requestStartMs = Date.now();
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const date = getKSTDateStr();
  const deadlineAtMs = requestStartMs + FAST_LOOP_DEADLINE_MS;
  const currentTickStartMs = Math.floor(requestStartMs / 60_000) * 60_000;
  // 손상 응답은 정상 "라이브 0"으로 보지 않는다. 본체 알림은 이번 틱 skip하되 fast-loop는
  // +20/+40초 재시도해 일시 KBO parse/schema 오류를 다음 분까지 끌지 않는다.
  const initialFetch = await fetchKboLiveGames(
    date,
    Math.min(deadlineAtMs, Date.now() + 10_000),
  );
  const games: KboRawGame[] = initialFetch.ok ? initialFetch.games : [];
  const liveGameIds = games
    .filter(g => g.GAME_STATE_SC === "2" && g.G_ID)
    .map(g => g.G_ID as string);

  // Android 위젯 갱신은 여전히 절대 URL이 필요하므로 baseUrl 계산은 유지한다.
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : req.nextUrl.origin);

  // 시작알림의 authoritative 첫 타석 근거와 highlight payload를 초기 KBO fetch 직후
  // 즉시 수집한다. 아래 LA/widget 파이프라인 조립과 병렬로 진행하되 highlight는 이
  // promise에서 이어지는 start accepted barrier가 끝난 뒤에만 release된다.
  const initialGameEventsPromise = fetchInitialGameEventsBounded(
    liveGameIds,
    async (gameId, evidenceDeadlineAtMs) => {
      const remainingMs = Math.max(1, evidenceDeadlineAtMs - Date.now());
      // 내부 호출도 동일한 절대 deadline을 공유한다. HTTP timeout이 사라졌으므로
      // runBeforeDeadline으로 기존 bounded fetch 의미를 그대로 유지한다.
      const result = await runBeforeDeadline(
        () => getGameEventsRouteResult(gameId),
        Date.now() + remainingMs,
      ).catch(() => null);
      const json = result?.body ?? null;
      const events = (json?.events ?? []) as GameEvent[];
      return {
        gameId,
        ok: (result?.status ?? 200) < 400,
        status: result?.status ?? 200,
        events,
        eventCount: (result?.status ?? 200) < 400 ? events.length : null,
        startPlateAppearance: (json?.startPlateAppearance ?? null) as StartPlateAppearanceEvidence | null,
      };
    },
    INITIAL_GAME_EVENTS_TIMEOUT_MS,
  );

  // 초기 Android 발송과 추가 +20/+40초 loop를 KBO fetch 직후 동시에 시작한다.
  // 초기 경로는 요청+18초에 실제 fans/prefs/token/FCM 요청까지 중단해 +20초의 최신
  // snapshot보다 뒤늦게 옛 상태를 발송하지 않는다. fast loop는 전체 +46초 deadline을 쓴다.
  type AndroidWidgetResult =
    | { games: number; sent: number; failed: number; cleaned: number; skipped: number; retryableFailed: number }
    | { error: string };

  // 서브틱 fast path도 같은 service 함수를 태운다. route와 module instance를 공유해
  // 같은 in-process 캐시/단일비행 경로를 재사용하고, 점수축 변화 경기만 호출한다.
  const fetchGameEventsForFastPath = async (gameIds: string[]): Promise<Map<string, GameEvent[]>> => {
    const out = new Map<string, GameEvent[]>();
    const settled = await Promise.allSettled(
      gameIds.map(async (gameId) => {
        const result = await runBeforeDeadline(
          () => getGameEventsRouteResult(gameId),
          Date.now() + 10_000,
        ).catch(() => null);
        if (!result || (result.status ?? 200) >= 400) return null;
        const json = result.body;
        return { gameId, events: (json?.events ?? []) as GameEvent[] };
      }),
    );
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value) out.set(s.value.gameId, s.value.events);
    }
    return out;
  };
  // 서브틱 fast path의 중계 한 줄도 service 직접 호출로 바꾼다. HTTP timeout 대신
  // 동일 10초 deadline을 걸어 무한 대기 경로를 만들지 않는다.
  const fetchRelayLinesForFastPath = async (gameIds: string[]): Promise<Map<string, string>> => {
    const out = new Map<string, string>();
    const settled = await Promise.allSettled(
      gameIds.map(async (gameId) => {
        const result = await runBeforeDeadline(
          () => getGameRelayRouteResult({ gameId }),
          Date.now() + 10_000,
        ).catch(() => null);
        if (!result || result.status >= 400) return null;
        const j = result.body;
        const line = latestRelayLine(j);
        return line ? { gameId, line } : null;
      }),
    );
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value) out.set(s.value.gameId, s.value.line);
    }
    return out;
  };

  // ── LA 오케스트레이션 (삼순 R2 blocker①② — 조립은 startLaOrchestration 하나로) ──
  // 친리티컬 패스(relay 한 줄 → 채널 ensure → 레거시용 직전-상태 스냅샷 → broadcast)를
  // 초기 KBO fetch 직후 독립 실행하고, 서브틱 게이트는 *초기 broadcast 완료 직후* 열린다.
  // 느린 fanout(레거시 per-토큰/start/iOS 위젯 FCM)은 직렬 큐로 분리 — tail>52s여도
  // 서브틱 broadcast가 굶지 않는다. 레거시는 broadcast 전 스냅샷을 주입받아 직전-틱
  // 판정을 유지(hash 순서 불변식 대체 — live-fast-path.ts 상단 주석).
  // 이 조립 코드 자체가 qa:la-fastpath의 회귀 대상(삼순 R2 "실배선 미검증" 해소).
  // broadcast 축(친리티컬 패스) 요청-절대 deadline(삼순 R4 blocker②) — 채널별 APNs 8s
  // timeout 직렬(5경기×2 env 전부 실패 = 80s)이 maxDuration(75s)을 못 넘게, broadcast/
  // catch-up/ensure 호출이 이 선을 넘으면 새 발송을 시작하지 않고 명시 종료한다(마지막
  // in-flight send 1건만 +8s → 상한 68s = drain deadline). 미발송 라이브 경기는
  // failedGameIds로 보고돼 fast path가 다음 틱 catch-up p10으로 재-arm한다.
  const broadcastDeadlineAtMs = requestStartMs + LA_BROADCAST_DEADLINE_MS;
  const laOrchestration = startLaOrchestration(
    {
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      fetchLiveGames: () =>
        fetchKboLiveGames(date, Math.min(deadlineAtMs, Date.now() + 10_000)),
      fetchRelayLines: fetchRelayLinesForFastPath,
      ensureChannels: (gs) =>
        ensureLiveActivityChannels(gs, { deadlineAtMs: broadcastDeadlineAtMs }),
      snapshotLegacyState: (ids) => snapshotChannelLastStates(ids),
      pushBroadcast: (gs, lp) =>
        pushLiveActivityChannelBroadcasts(gs, lp, { deadlineAtMs: broadcastDeadlineAtMs }),
      // 유실 catch-up — 무변화여도 해당 경기 p10 current-state 강제 재발송(p5/skip 승격 — 삼순 R2③).
      pushBroadcastCatchup: (gs, lp, ids) =>
        pushLiveActivityChannelBroadcasts(gs, lp, {
          forceCurrentStateGameIds: new Set(ids),
          deadlineAtMs: broadcastDeadlineAtMs,
        }),
      pushLegacyLa: (gs, lp, snapshot) =>
        pushLiveActivityUpdates(gs, lp, { channelLastStateOverride: snapshot }),
      pushStarts: (gs) => pushLiveActivityStarts(gs),
      pushIosWidget: (gs, lp) => pushIosWidgetLiveUpdates(gs, lp),
      pushAndroid: (gs, tr) =>
        pushAndroidWidgetLiveUpdates(gs, baseUrl, {
          dedupeAgainstLast: true,
          deadlineAtMs,
          sourceAtMs: tr.sourceAtMs,
          fetchedAtMs: tr.fetchedAtMs,
        }),
      fetchGameEvents: fetchGameEventsForFastPath,
      notifyScore: (gs, ev) => notifyScoreEvents(gs, ev),
      // 계측 — diff 감지(KBO 응답 확보)→발송 완료 latency. 배포 후 효과 실측용.
      onTickResult: (tick) => {
        if ("detectToSendMs" in tick) {
          console.log(
            `[warmup] fast-path tick +${Date.now() - requestStartMs}ms changed=${tick.changedGameIds.join(",")}` +
            ` scoreChanged=${tick.scoreChangedLiveGameIds.join(",") || "-"} detect→send ${tick.detectToSendMs}ms`,
          );
        } else if (tick.catchup) {
          console.log(
            `[warmup] fast-path catchup +${Date.now() - requestStartMs}ms games=${tick.catchup.gameIds.join(",")}`,
          );
        }
      },
    },
    {
      requestStartMs,
      deadlineAtMs,
      initialFetchOk: initialFetch.ok,
      games,
      liveGameIds,
    },
  );
  // channel_born 장부 self-heal — 채널 ensure/broadcast critical path가 끝난 뒤에만 시작해
  // active 행 SHARE lock이 APNs fanout을 기다리게 하지 않는다. legacy/start fanout과는
  // 독립 병렬이며 exact-match ACK RPC가 5초/1,000행으로 유계된다. 실패도 fanout은
  // 끝까지 진행하고 마지막 응답 5xx+구조화 metrics로 cron alert에 노출한다.
  const channelBornReconcilePromise = laOrchestration.criticalPromise.then(
    () => reconcileChannelBornFromAcks(),
    () => reconcileChannelBornFromAcks(),
  );

  const { initialPromise: initialAndroidWidgetPromise, fastPromise: fastRefreshPromise } =
    startWidgetRefreshPipelines<AndroidWidgetResult>({
      pushInitial: pushAndroidWidgetLiveUpdates,
      // 서브틱 fast path — diff도 catch-up pending도 없으면 DB/APNs/FCM 무접근 즉시 반환
      // (conn pool 보호), 변화 시 안드 위젯 ∥ broadcast(크리티컬) ∥ 득점 푸시 + 느린 fanout
      // 큐잉, 무변화 첫 틱은 유실 대비 broadcast-only p10 catch-up 1회(삼순 R1②·R2③).
      // 시작알림/순위/요약/활약/autostart/wake는 분 단위 본체 전용(#798/#800 게이트 비간섭).
      runFast: () => laOrchestration.runFastLoop(),
    }, {
      requestStartMs,
      overallDeadlineAtMs: deadlineAtMs,
      initial: initialFetch.ok ? {
        games,
        baseUrl,
        sourceAtMs: initialFetch.trace.sourceAtMs,
        fetchedAtMs: initialFetch.trace.fetchedAtMs,
      } : null,
      initialSkipped: { error: "kbo_fetch_failed" },
    });
  const androidWidgetPromise = initialAndroidWidgetPromise.catch((e): AndroidWidgetResult => {
    console.error("[warmup] android widget live update failed:", (e as Error).message);
    return { error: (e as Error).message };
  });

  const results = await initialGameEventsPromise;

  // self-fetch로 받은 game-events를 gameId별로 모음 (S5 득점 알림용)
  const eventsByGame = new Map<string, GameEvent[]>();
  const startPlateAppearanceByGame = new Map<string, StartPlateAppearanceEvidence>();
  for (const r of results) {
    if (r.ok) {
      eventsByGame.set(r.gameId, r.events);
      if (r.startPlateAppearance) {
        startPlateAppearanceByGame.set(r.gameId, r.startPlateAppearance);
      }
    }
  }

  // 경기 시작/종료 푸시 (push-notifications-v1 S4) — 같은 게임 목록을 재사용.
  // 실패해도 warmup 본연의 동작(이벤트 캐시)에 영향 없음.
  let gameNotify:
    | { started: number; ended: number }
    | { error: string } = { started: 0, ended: 0 };
  try {
    // observedAtMs = 이 games를 fetch한 시각. 시작알림 90초 게이트는 관측 시각끼리 비교해야
    // 하므로(연속 틱 관측 판정), 앞단 처리/FCM 발송 지연이 stale 오판을 만들지 않게 한다
    // (2026-07-24 LG:한화 시작알림 억제 사고).
    gameNotify = await notifyGameStatusTransitions(games, {
      observedAtMs: initialFetch.trace.fetchedAtMs,
      deadlineAtMs,
      startPlateAppearanceByGame,
    });
  } catch (e) {
    gameNotify = { error: (e as Error).message };
    console.error("[warmup] game status notify failed:", (e as Error).message);
  }

  // 팀 순위 변동 푸시 — 순위가 바뀐 순간(옵션 A) 즉시 발송. 매분 standings를 직전 발송
  // 순위와 비교(별도 cron 불필요). 실패해도 warmup 본연 동작 무영향.
  let rankNotify: { changed: number } | { skipped: string } | { error: string } = { changed: 0 };
  try {
    rankNotify = await notifyTeamRankChanges();
  } catch (e) {
    rankNotify = { error: (e as Error).message };
    console.error("[warmup] team rank notify failed:", (e as Error).message);
  }

  // 내 팀 득점 푸시 (push-notifications-v1 S5a) — game-events의 득점 이벤트 기반.
  let scoreNotify: { scored: number; conceded: number } | { error: string } = { scored: 0, conceded: 0 };
  try {
    scoreNotify = await notifyScoreEvents(games, eventsByGame);
  } catch (e) {
    scoreNotify = { error: (e as Error).message };
    console.error("[warmup] score notify failed:", (e as Error).message);
  }

  // 이닝 득점 요약 푸시 (S5 — my_team_score_inning_summary). 이닝 종료 시 묶음 1건.
  let summaryNotify: { summarized: number } | { error: string } = { summarized: 0 };
  try {
    summaryNotify = await notifyInningSummaries(games, eventsByGame);
  } catch (e) {
    summaryNotify = { error: (e as Error).message };
    console.error("[warmup] inning summary notify failed:", (e as Error).message);
  }

  // 최애선수 활약(타자) 푸시 (push-notifications-v1 S5b) — 장타/홈런 batter 매칭.
  let highlightNotify: { highlighted: number } | { error: string } = { highlighted: 0 };
  try {
    highlightNotify = await notifyPlayerHighlights(games, eventsByGame, {
      startAcceptedBeforeMs: currentTickStartMs,
      deadlineAtMs,
    });
  } catch (e) {
    highlightNotify = { error: (e as Error).message };
    console.error("[warmup] highlight notify failed:", (e as Error).message);
  }

  // 잠금화면 Live Activity 무음 wake (Layer 2) — 카드는 떴는데 update 토큰이 없는 유저의
  // iOS 기기를 무음 푸시로 깨워 토큰 등록 유도(앱 안 열어도 갱신). FCM 무음이라 APNs와 무관.
  let liveActivityWake:
    | { woke: number; failed: number; skipped: number; cleaned: number; ok: boolean }
    | { error: string } = { woke: 0, failed: 0, skipped: 0, cleaned: 0, ok: true };
  try {
    liveActivityWake = await pushLiveActivitySilentWakes(games);
  } catch (e) {
    liveActivityWake = { error: (e as Error).message };
    console.error("[warmup] live activity wake failed:", (e as Error).message);
  }

  // 안드 홈위젯 fast-refresh (맥미니 의존 0, Vercel 함수 내부 루프) — 라이브 중계 위젯
  // 지연을 ~60초(1분 크론) → ~20초로 단축. 추가 사이클은 *안드 위젯만* 재발사하고
  // (득점/랭크/LA 등 알림 서브시스템은 위에서 1회만 — 중복 알림 방지), dedupe로
  // 상태가 바뀐 경기만 발사해 배터리/FCM 쿼터 부담을 막는다. deadline은 *요청 진입 시각*
  // 기준 절대값(FAST_LOOP_DEADLINE_MS)이라 위 warmup 본작업이 오래 걸려도 내부 68s budget/
  // 다음 크론 틱과 겹치지 않는다. 오케스트레이션은 widget-fast-loop.ts(테스트 커버) 참조.
  // LA 친리티컬/느린 fanout은 초기 fetch 직후 독립 실행됨(삼순 R2①) — 여기서 결과만 회수.
  // drainFanout은 la/android/score 축 fanout을 *요청 진입 기준 deadline*(LA_FANOUT_DRAIN_
  // DEADLINE_MS=68s) 안에서만 대기하고, 초과 시 partial(timedOut)로 즉시 끊어 내부 budget
  // 초과 대기를 구조적으로 막는다(삼순 R3 blocker③). 미완료분은 다음 분 cron이
  // 멱등 재발송(DB 선점/CAS/hash dedupe)으로 수습.
  const drainDeadlineAtMs = requestStartMs + LA_FANOUT_DRAIN_DEADLINE_MS;
  const [laCritical, laFanoutDrain, androidWidget, fastRefresh, channelBornReconcile] = await Promise.all([
    laOrchestration.criticalPromise,
    laOrchestration.drainFanout({
      deadlineAtMs: drainDeadlineAtMs,
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    }),
    androidWidgetPromise,
    fastRefreshPromise,
    channelBornReconcilePromise,
  ]);
  const { lastPlayByGame, laChannels, laBroadcast } = laCritical;
  const laFanout = laFanoutDrain.results;
  const cycle0Fanout = laFanout.find((f) => f.label === "cycle0")?.result as
    | { legacyLa?: unknown; liveActivityStart?: unknown; iosWidget?: unknown }
    | undefined;
  const liveActivity = cycle0Fanout?.legacyLa ?? { error: "la_fanout_missing" };
  const liveActivityStart = cycle0Fanout?.liveActivityStart ?? { error: "la_fanout_missing" };
  const iosWidget = cycle0Fanout?.iosWidget ?? { error: "la_fanout_missing" };

  return NextResponse.json({
    date,
    polled: liveGameIds.length,
    liveGameIds,
    gameNotify,
    rankNotify,
    scoreNotify,
    summaryNotify,
    androidWidget,
    highlightNotify,
    liveActivity,
    laChannels,
    laBroadcast,
    liveActivityStart,
    liveActivityWake,
    channelBornReconcile,
    iosWidget,
    fastRefresh,
    // 서브틱 느린 fanout 결과(레거시/iOS 위젯/안드/득점 — 큰 단위 관제용). cycle0은 위
    // 필드로 평탄화. drain이 deadline에 걸려 partial이면 timedOut/pending으로 다음 분 cron
    // 수습 대상이 있음을 관제에 남긴다(삼순 R3 blocker③).
    laFanoutTicks: laFanout.filter((f) => f.label !== "cycle0"),
    laFanoutTimedOut: laFanoutDrain.timedOut,
    laFanoutPending: laFanoutDrain.pendingCount,
    lastPlays: Object.fromEntries(lastPlayByGame),
    results: results.map(r => ({
      gameId: r.gameId,
      ok: r.ok,
      status: r.status,
      eventCount: r.eventCount,
    })),
  }, { status: channelBornReconcile.ok ? 200 : 500 });
}
