import { NextRequest, NextResponse } from "next/server";
import type { KboRawGame } from "@/types/api";
import type { GameEvent } from "@/types/game-events";
import { notifyGameStatusTransitions } from "@/lib/notifications/game-status";
import { notifyTeamRankChanges } from "@/lib/notifications/team-rank";
import { notifyScoreEvents, notifyInningSummaries } from "@/lib/notifications/game-score";
import { notifyPlayerHighlights } from "@/lib/notifications/player-highlight";
import { pushLiveActivityUpdates, pushLiveActivityStarts, pushLiveActivitySilentWakes } from "@/lib/notifications/live-activity";
import { ensureLiveActivityChannels, pushLiveActivityChannelBroadcasts } from "@/lib/notifications/live-activity-channels";
import { pushAndroidWidgetLiveUpdates } from "@/lib/notifications/android-widget-live";
import { pushIosWidgetLiveUpdates } from "@/lib/notifications/ios-widget-live";
import {
  runWidgetFastLoop,
  startWidgetRefreshPipelines,
  FAST_LOOP_DEADLINE_MS,
  parseKboGameListPayload,
} from "@/lib/notifications/widget-fast-loop";
import {
  seedLiveFastPathState,
  runLiveFastPathTick,
  gateFastPathOnLaAxis,
} from "@/lib/notifications/live-fast-path";
import { runBeforeDeadline } from "@/lib/async-deadline";

/**
 * Warm up the in-memory prevState cache of /api/game-events for every
 * currently-live KBO game. Without this, the cache is only populated when
 * a client opens a game page, so any plays that happen between the actual
 * first pitch and the first client visit are emitted as `game_start` only —
 * the BoxScore stat lines accrued in that window never become events.
 *
 * Self-fetches the same game-events route used by clients so the warm-up
 * traverses the exact diff path; no parallel logic to keep in sync.
 */

const CRON_SECRET = process.env.CRON_SECRET || "";
const KBO_MAIN = "https://www.koreabaseball.com/ws/Main.asmx";

// 함수 내부 fast-refresh 루프(+15/+30/+45s 서브틱)가 돌 수 있게 실행시간 상한을 늘린다
// (Vercel Pro, news-clipping 300s 선례). 루프는 요청-절대 deadline(FAST_LOOP_DEADLINE_MS=52s)
// 이후 어떤 작업도 *시작*하지 않고, 75s는 마지막 서브틱이 이미 시작한 LA/FCM 발송 tail의
// 안전 마진(23s)이다. 다음 분 cron과의 짧은 겹침 구간 중복 발송은 DB 선점/CAS/hash
// dedupe가 차단한다(live-fast-path.ts 주석 참조).
export const maxDuration = 75;

function getKSTDateStr(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10).replace(/-/g, "");
}

// KBO 라이브 스코어보드 원천 — fast-refresh 루프가 매 사이클 신선한 games를 다시 읽도록 추출.
// (2026-05-20: KBO가 Referer가 koreabaseball.com이 아닌 요청을 IE 에러 페이지로 막음.)
// ok:false = HTTP/network 실패 — fast-loop가 "라이브 0(정상 종료)"과 구분해 다음 tick에
// 재시도하도록 오류를 빈 배열로 축약하지 않는다(삼순 blocker②). deadlineAtMs 지정 시 abort로
// fetch 완료도 deadline 안에 묶는다(미지정 = 기존 동작 그대로, 메인 경로 무변경).
export async function fetchKboLiveGames(
  date: string,
  deadlineAtMs?: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  ok: boolean;
  games: KboRawGame[];
  trace: { sourceAtMs: number; fetchedAtMs: number };
}> {
  const sourceAtMs = Date.now();
  try {
    const remainingMs = deadlineAtMs == null ? null : deadlineAtMs - Date.now();
    const r = await runBeforeDeadline(
      () => fetchImpl(`${KBO_MAIN}/GetKboGameList`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
          "Referer": "https://www.koreabaseball.com/Schedule/ScoreBoard.aspx",
        },
        body: `leId=1&srId=0,1,3,4,5,7,8,9&date=${date}`,
        cache: "no-store",
        ...(remainingMs != null ? { signal: AbortSignal.timeout(Math.max(1, remainingMs)) } : {}),
      }),
      deadlineAtMs,
    );
    if (!r.ok) return { ok: false, games: [], trace: { sourceAtMs, fetchedAtMs: Date.now() } };
    const json = await runBeforeDeadline(() => r.json(), deadlineAtMs).catch(() => null);
    const games = parseKboGameListPayload(json);
    const fetchedAtMs = Date.now();
    if (games === null) return { ok: false, games: [], trace: { sourceAtMs, fetchedAtMs } };
    return { ok: true, games, trace: { sourceAtMs, fetchedAtMs } };
  } catch {
    return { ok: false, games: [], trace: { sourceAtMs, fetchedAtMs: Date.now() } };
  }
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

  // Self-fetch to traverse the same generateEvents path the client takes.
  // ⚠️ VERCEL_URL은 *배포별 URL*이라 Deployment Protection(인증)이 걸려 self-fetch가
  // 401로 막힐 수 있다(S5 득점/선수활약 알림이 조용히 0건 나던 원인). 따라서 보호가 없는
  // *공개 프로덕션 도메인* VERCEL_PROJECT_PRODUCTION_URL을 먼저 쓴다. (S4/Live Activity는
  // games를 직접 써서 self-fetch 의존이 없어 영향 없었음.)
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : req.nextUrl.origin);

  // 초기 Android 발송과 추가 +20/+40초 loop를 KBO fetch 직후 동시에 시작한다.
  // 초기 경로는 요청+18초에 실제 fans/prefs/token/FCM 요청까지 중단해 +20초의 최신
  // snapshot보다 뒤늦게 옛 상태를 발송하지 않는다. fast loop는 전체 +46초 deadline을 쓴다.
  type AndroidWidgetResult =
    | { games: number; sent: number; failed: number; cleaned: number; skipped: number; retryableFailed: number }
    | { error: string };

  // 서브틱 diff baseline — cycle 0 스냅샷은 아래 본체 경로가 발송하므로 서브틱은 이후
  // *달라진* 것만 처리. 초기 fetch 실패 시 빈 baseline → 첫 성공 서브틱이 그 분을 복구.
  const fastPathState = seedLiveFastPathState(initialFetch.ok ? games : []);
  // 서브틱 fast path의 game-events self-fetch — 본체와 동일 경로(공개 도메인 baseUrl).
  // 점수축 변화 경기만 호출되므로 타석 단위 변화마다 이벤트 생성 fetch가 돌지 않는다.
  const fetchGameEventsForFastPath = async (gameIds: string[]): Promise<Map<string, GameEvent[]>> => {
    const out = new Map<string, GameEvent[]>();
    const settled = await Promise.allSettled(
      gameIds.map(async (gameId) => {
        const r = await fetch(`${baseUrl}/api/game-events?gameId=${gameId}`, {
          cache: "no-store",
          headers: { "User-Agent": "kbo-everyday-warmup/1.0" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) return null;
        const json = await r.json().catch(() => null);
        return { gameId, events: (json?.events ?? []) as GameEvent[] };
      }),
    );
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value) out.set(s.value.gameId, s.value.events);
    }
    return out;
  };
  // 서브틱 fast path의 중계 한 줄 수집 — 본체와 동일 패턴(실패 격리, 줄만 안 뜨임).
  const fetchRelayLinesForFastPath = async (gameIds: string[]): Promise<Map<string, string>> => {
    const out = new Map<string, string>();
    const settled = await Promise.allSettled(
      gameIds.map(async (gameId) => {
        const r = await fetch(`${baseUrl}/api/game-relay?gameId=${gameId}`, {
          cache: "no-store",
          headers: { "User-Agent": "kbo-everyday-warmup/1.0" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) return null;
        const j = await r.json().catch(() => null);
        const line = latestRelayLine(j);
        return line ? { gameId, line } : null;
      }),
    );
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value) out.set(s.value.gameId, s.value.line);
    }
    return out;
  };

  // ── LA 우선 축 (삼순 R1 blocker① — 느린 본체가 서브틱을 굮기던 직렬화 교체) ──
  // 잠금화면 LA 계약(서버 감지→발송 시도 SLO)은 느린 본체(game-events self-fetch·
  // 시작/순위/득점/요약/활약 알림)와 무관해야 한다. 본체가 52s deadline을 넘겨도
  // (운영 60s 504 재현) broadcast가 굮지 않도록, LA 발송 축(중계 한 줄 → 채널 ensure →
  // 레거시 per-토큰 → broadcast → start → iOS 위젯)을 초기 KBO fetch 직후 독립 실행하고
  // 서브틱은 *이 축의 완료만* 기다린다(gateFastPathOnLaAxis). stale-overwrite 방지는
  // LA 발송 축 직렬화로 충분 — 본체의 알림/집계 경로는 LA 상태(채널 hash/위젯 커서)를
  // 건드리지 않는다. 순서 불변식(레거시가 직전 hash를 읽은 뒤 broadcast가 전진)은
  // 축 내부 순차 실행으로 그대로 유지된다.
  type LaAxisResult = {
    lastPlayByGame: Map<string, string>;
    laChannels: { created: number } | { error: string };
    liveActivity: { pushed: number; ended: number; cleaned: number } | { error: string };
    laBroadcast:
      | { updates: number; heartbeats: number; catchups: number; skipped: number; ends: number; deleted: number }
      | { error: string };
    liveActivityStart: { started: number } | { error: string };
    iosWidget:
      | { games: number; sent: number; failed: number; skipped: number; cleaned: number }
      | { error: string };
  };
  const laAxisPromise: Promise<LaAxisResult> = (async () => {
    // 잠금화면 LA "중계 한 줄" — 네이버 문자중계 최근 플레이(실패 격리, 줄만 안 뜸).
    const lastPlayByGame = await fetchRelayLinesForFastPath(liveGameIds).catch(
      () => new Map<string, string>(),
    );

    // Broadcast 채널 준비 (스펙 v4 §서버 2) — start 윈도우 경기에 env별 채널 생성(멱등).
    let laChannels: LaAxisResult["laChannels"] = { created: 0 };
    try {
      laChannels = await ensureLiveActivityChannels(games);
    } catch (e) {
      laChannels = { error: (e as Error).message };
      console.error("[warmup] la channel ensure failed:", (e as Error).message);
    }

    // 레거시(per-토큰) 갱신 — 채널 행의 지난 틱 상태를 읽으므로 broadcast보다 먼저 실행.
    let liveActivity: LaAxisResult["liveActivity"] = { pushed: 0, ended: 0, cleaned: 0 };
    try {
      liveActivity = await pushLiveActivityUpdates(games, lastPlayByGame);
    } catch (e) {
      liveActivity = { error: (e as Error).message };
      console.error("[warmup] live activity push failed:", (e as Error).message);
    }

    // Broadcast 채널 갱신 (스펙 v4 §서버 5·6).
    let laBroadcast: LaAxisResult["laBroadcast"] = {
      updates: 0, heartbeats: 0, catchups: 0, skipped: 0, ends: 0, deleted: 0,
    };
    try {
      laBroadcast = await pushLiveActivityChannelBroadcasts(games, lastPlayByGame);
    } catch (e) {
      laBroadcast = { error: (e as Error).message };
      console.error("[warmup] la broadcast failed:", (e as Error).message);
    }

    // 잠금화면 LA 자동 시작 (W3b) — 게임 단위 1회 선점이라 중복 시작 없음.
    let liveActivityStart: LaAxisResult["liveActivityStart"] = { started: 0 };
    try {
      liveActivityStart = await pushLiveActivityStarts(games);
    } catch (e) {
      liveActivityStart = { error: (e as Error).message };
      console.error("[warmup] live activity start failed:", (e as Error).message);
    }

    // iOS 홈 위젯 무음 갱신 (1.0.9 build 17) — 자체 CAS 커서라 순서 무관이지만 본체 순서 유지.
    let iosWidget: LaAxisResult["iosWidget"] = { games: 0, sent: 0, failed: 0, skipped: 0, cleaned: 0 };
    try {
      iosWidget = await pushIosWidgetLiveUpdates(games, lastPlayByGame);
    } catch (e) {
      iosWidget = { error: (e as Error).message };
      console.error("[warmup] ios widget live update failed:", (e as Error).message);
    }

    return { lastPlayByGame, laChannels, liveActivity, laBroadcast, liveActivityStart, iosWidget };
  })();
  // 서브틱 게이트용 완료 신호 — 각 단계가 자체 try/catch라 reject는 없지만 방어적으로 흡수.
  const laAxisDone: Promise<void> = laAxisPromise.then(() => undefined, () => undefined);

  const shouldRetryFast = !initialFetch.ok || liveGameIds.length > 0;
  const { initialPromise: initialAndroidWidgetPromise, fastPromise: fastRefreshPromise } =
    startWidgetRefreshPipelines<AndroidWidgetResult>({
      pushInitial: pushAndroidWidgetLiveUpdates,
      runFast: () => shouldRetryFast
        ? runWidgetFastLoop(
            {
              now: () => Date.now(),
              sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
              fetchLiveGames: () =>
                fetchKboLiveGames(date, Math.min(deadlineAtMs, Date.now() + 10_000)),
              // 서브틱 fast path — diff도 catch-up pending도 없으면 DB/APNs/FCM 무접근 즉시
              // 반환(conn pool 보호), 변화 시 안드 위젯 ∥ (레거시 LA → broadcast → iOS 위젯) ∥
              // 득점 푸시 재실행, 무변화 첫 틱은 유실 대비 broadcast-only catch-up 1회(삼순 R1②).
              // 시작알림/순위/요약/활약/autostart/wake는 분 단위 본체 전용(#798/#800 게이트 비간섭).
              // 게이트: LA 축 완료만 대기(느린 본체 무관 — 삼순 R1①), deadline 유계.
              pushWidgets: gateFastPathOnLaAxis({
                laAxisDone,
                deadlineAtMs,
                now: () => Date.now(),
                sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
                runTick: async (freshGames, trace) => {
                  const tick = await runLiveFastPathTick(
                    {
                      now: () => Date.now(),
                      fetchRelayLines: fetchRelayLinesForFastPath,
                      pushAndroid: (gs, tr) =>
                        pushAndroidWidgetLiveUpdates(gs, baseUrl, {
                          dedupeAgainstLast: true,
                          deadlineAtMs,
                          sourceAtMs: tr.sourceAtMs,
                          fetchedAtMs: tr.fetchedAtMs,
                        }),
                      pushLegacyLa: (gs, lp) => pushLiveActivityUpdates(gs, lp),
                      pushBroadcast: (gs, lp) => pushLiveActivityChannelBroadcasts(gs, lp),
                      // 유실 catch-up — 무변화여도 해당 경기 p10 current-state 강제 재발송.
                      pushBroadcastCatchup: (gs, lp, ids) =>
                        pushLiveActivityChannelBroadcasts(gs, lp, {
                          forceCurrentStateGameIds: new Set(ids),
                        }),
                      pushIosWidget: (gs, lp) => pushIosWidgetLiveUpdates(gs, lp),
                      fetchGameEvents: fetchGameEventsForFastPath,
                      notifyScore: (gs, ev) => notifyScoreEvents(gs, ev),
                    },
                    fastPathState,
                    freshGames,
                    trace,
                  );
                  // 계측 — diff 감지(KBO 응답 확보)→발송 완료 latency. 배포 후 효과 실측용.
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
                  return tick;
                },
              }),
            },
            { requestStartMs },
          )
        : Promise.resolve([]),
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

  const results = await Promise.allSettled(
    liveGameIds.map(gameId =>
      fetch(`${baseUrl}/api/game-events?gameId=${gameId}`, {
        cache: "no-store",
        headers: { "User-Agent": "kbo-everyday-warmup/1.0" },
      }).then(async r => {
        const json = r.ok ? await r.json().catch(() => null) : null;
        const events = (json?.events ?? []) as GameEvent[];
        return { gameId, ok: r.ok, status: r.status, events, eventCount: r.ok ? events.length : null };
      }),
    ),
  );

  // self-fetch로 받은 game-events를 gameId별로 모음 (S5 득점 알림용)
  const eventsByGame = new Map<string, GameEvent[]>();
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.ok) {
      eventsByGame.set(r.value.gameId, r.value.events);
    }
  }

  // 경기 시작/종료 푸시 (push-notifications-v1 S4) — 같은 게임 목록을 재사용.
  // 실패해도 warmup 본연의 동작(이벤트 캐시)에 영향 없음.
  let gameNotify: { started: number; ended: number } | { error: string } = { started: 0, ended: 0 };
  try {
    gameNotify = await notifyGameStatusTransitions(games);
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
    highlightNotify = await notifyPlayerHighlights(games, eventsByGame);
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
  // 기준 절대값(FAST_LOOP_DEADLINE_MS)이라 위 warmup 본작업이 오래 걸려도 maxDuration(75s)/
  // 다음 크론 틱과 겹치지 않는다. 오케스트레이션은 widget-fast-loop.ts(테스트 커버) 참조.
  // LA 축은 초기 fetch 직후 독립 실행됨(삼순 R1①) — 여기서 결과만 회수.
  const [laAxis, androidWidget, fastRefresh] = await Promise.all([
    laAxisPromise,
    androidWidgetPromise,
    fastRefreshPromise,
  ]);
  const { lastPlayByGame, laChannels, liveActivity, laBroadcast, liveActivityStart, iosWidget } =
    laAxis;

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
    iosWidget,
    fastRefresh,
    lastPlays: Object.fromEntries(lastPlayByGame),
    results: results.map(r =>
      r.status === "fulfilled"
        ? { gameId: r.value.gameId, ok: r.value.ok, status: r.value.status, eventCount: r.value.eventCount }
        : { error: String(r.reason) },
    ),
  });
}
