// QA 스모크 — 안드 위젯 fast-refresh(warmup 함수 내부 루프)의 변화 감지 dedupe 판정 +
// fast-loop 오케스트레이션(절대 deadline/fetch 오류 구분/실패 dedupe/안드 토큰 필터) 검증.
// fake clock + 주입 의존성으로 network/supabase/FCM 없이 동작(삼순 #718 fast-loop NO-GO 4건).
// android-widget-live는 트랜지티브로 supabase 싱글톤을 로드하므로 env 더미 선주입(프로덕션 무변경).
import "./_smoke-env";
import { generateKeyPairSync } from "node:crypto";
import {
  shouldSkipWidgetPush,
  widgetStateSignature,
  pushAndroidWidgetLiveUpdates,
  __resetWidgetSigCacheForTest,
} from "../../src/lib/notifications/android-widget-live";
import {
  runWidgetFastLoop,
  startWidgetRefreshPipelines,
  initialWidgetPushDeadlineAt,
  INITIAL_PUSH_DEADLINE_MS,
  FAST_LOOP_TARGETS_MS,
  parseKboGameListPayload,
  type FastLoopDeps,
} from "../../src/lib/notifications/widget-fast-loop";
import { sendFcmToUsers } from "../../src/lib/notifications/fcm";
import { deliverTokenChunks } from "../../src/lib/notifications/fcm-batch";
import { sendDeadlineFcmChunk } from "../../src/lib/notifications/fcm-deadline-transport";
import { fetchKboLiveGames } from "../../src/app/api/cron/game-events-warmup/route";
import type { fansOfTeams } from "../../src/lib/notifications/game-status";
import { supabaseAdmin } from "../../src/lib/supabase/admin";
import type { KboRawGame } from "../../src/types/api";

let pass = 0;
let fail = 0;
function check(name: string, got: boolean, want: boolean) {
  if (got === want) { pass++; }
  else { fail++; console.error(`✗ ${name}: got ${got}, want ${want}`); }
}

// cycle 0 (dedupe=false) — 시그니처가 같아도 항상 발사(현행 동작 보존).
check("dedupe off, same sig → push", shouldSkipWidgetPush("A", "A", false), false);
check("dedupe off, diff sig → push", shouldSkipWidgetPush("A", "B", false), false);
check("dedupe off, no prev → push", shouldSkipWidgetPush(undefined, "A", false), false);

// fast-loop 추가 사이클 (dedupe=true)
check("dedupe on, no prev → push (첫 발사)", shouldSkipWidgetPush(undefined, "A", true), false);
check("dedupe on, same sig → skip (무변화)", shouldSkipWidgetPush("A", "A", true), true);
check("dedupe on, diff sig → push (변화)", shouldSkipWidgetPush("A", "B", true), false);
check("dedupe on, empty→value → push", shouldSkipWidgetPush("", "A", true), false);
check("dedupe on, same empty → skip", shouldSkipWidgetPush("", "", true), true);

// 실제 payload.data JSON 시그니처 케이스 — 스코어 변화 감지
const base = JSON.stringify({ kind: "game_live", w_as: "1", w_hs: "0", w_status: "LIVE 4회초", w_outs: "1", w_diamond: "100", w_lastplay: "김현수 안타" });
const sameState = JSON.stringify({ kind: "game_live", w_as: "1", w_hs: "0", w_status: "LIVE 4회초", w_outs: "1", w_diamond: "100", w_lastplay: "김현수 안타" });
const scored = JSON.stringify({ kind: "game_live", w_as: "1", w_hs: "1", w_status: "LIVE 4회초", w_outs: "1", w_diamond: "000", w_lastplay: "오스틴 적시타" });
const newRelay = JSON.stringify({ kind: "game_live", w_as: "1", w_hs: "0", w_status: "LIVE 4회초", w_outs: "2", w_diamond: "100", w_lastplay: "박병호 삼진" });
check("real: 동일 상태 → skip", shouldSkipWidgetPush(base, sameState, true), true);
check("real: 득점 변화 → push", shouldSkipWidgetPush(base, scored, true), false);
check("real: 아웃/중계 변화 → push", shouldSkipWidgetPush(base, newRelay, true), false);

// 순서 메타(w_source_at) 제외 canonical 시그니처 — 삼순: 매 사이클 sourceAt가 바뜘도 무변화 skip 유지
function checkEq(name: string, got: string, want: string) {
  if (got === want) { pass++; }
  else { fail++; console.error(`✗ ${name}: got ${got}, want ${want}`); }
}
const d1 = { kind: "game_live", w_as: "1", w_hs: "0", w_status: "LIVE 4회초", w_source_at: "1000", w_fetched_at: "1005" };
const d2 = { kind: "game_live", w_as: "1", w_hs: "0", w_status: "LIVE 4회초", w_source_at: "9999", w_fetched_at: "10004" };
const d3 = { kind: "game_live", w_as: "2", w_hs: "0", w_status: "LIVE 4회초", w_source_at: "1001", w_fetched_at: "1006" };
checkEq("sig: w_source_at 만 달라도 동일(순서 메타 제외)", widgetStateSignature(d1), widgetStateSignature(d2));
check("sig: sourceAt만 다른 두 사이클 → skip 유지", shouldSkipWidgetPush(widgetStateSignature(d1), widgetStateSignature(d2), true), true);
check("sig: 득점 변화는 sourceAt 무관하게 push", shouldSkipWidgetPush(widgetStateSignature(d1), widgetStateSignature(d3), true), false);
if (widgetStateSignature(d1).includes("w_source_at")) { fail++; console.error("✗ sig should not contain w_source_at"); } else { pass++; }
if (widgetStateSignature(d1).includes("w_fetched_at")) { fail++; console.error("✗ sig should not contain w_fetched_at"); } else { pass++; }

// KBO parse/schema fail-close — 손상 응답은 정상 game:[]과 구분한다.
check("schema: 명시적 빈 game 배열은 정상", parseKboGameListPayload({ game: [] })?.length === 0, true);
check("schema: game 누락은 실패", parseKboGameListPayload({}) === null, true);
check("schema: JSON null은 실패", parseKboGameListPayload(null) === null, true);
check("schema: 행 G_ID 누락은 실패", parseKboGameListPayload({ game: [{ GAME_STATE_SC: "2", AWAY_NM: "LG", HOME_NM: "KT" }] }) === null, true);
check("schema: 행 state 타입 손상은 실패", parseKboGameListPayload({ game: [{ G_ID: "G1", GAME_STATE_SC: 2, AWAY_NM: "LG", HOME_NM: "KT" }] }) === null, true);
check("schema: 최소 유효 행 통과", parseKboGameListPayload({ game: [{ G_ID: "20260721LGKT0", GAME_STATE_SC: "2", AWAY_NM: "LG", HOME_NM: "KT" }] })?.length === 1, true);
check("schema: unknown state 실패", parseKboGameListPayload({ game: [{ G_ID: "20260721LGKT0", GAME_STATE_SC: "BROKEN", AWAY_NM: "LG", HOME_NM: "KT" }] }) === null, true);
check("schema: malformed game id 실패", parseKboGameListPayload({ game: [{ G_ID: "x", GAME_STATE_SC: "2", AWAY_NM: "LG", HOME_NM: "KT" }] }) === null, true);
check("schema: 빈 원정 팀명 실패", parseKboGameListPayload({ game: [{ G_ID: "20260721LGKT0", GAME_STATE_SC: "2", AWAY_NM: "  ", HOME_NM: "KT" }] }) === null, true);
check("schema: 빈 홈 팀명 실패", parseKboGameListPayload({ game: [{ G_ID: "20260721LGKT0", GAME_STATE_SC: "2", AWAY_NM: "LG", HOME_NM: "" }] }) === null, true);
check("schema: state 한 자리 숫자(0~9) domain 통과", ["0", "1", "2", "3", "4", "5", "9"].every((state) =>
  parseKboGameListPayload({ game: [{ G_ID: "20260721LGKT0", GAME_STATE_SC: state, AWAY_NM: "LG", HOME_NM: "KT" }] })?.length === 1), true);
// 2026-07-23 P0 회귀: 취소경기(state "4", 그라운드사정) 1건 혼재가 payload 전체를 무효화해
// 라이브 경기 알림/위젯이 전부 0건이 되던 실사고 재현 — 5경기 payload가 그대로 통과해야 한다.
check("schema: 취소경기(state 4) 혼재 payload 통과(7/23 실사고 회귀)", (() => {
  const rows = [
    { G_ID: "20260723NCLG0", GAME_STATE_SC: "2", AWAY_NM: "NC", HOME_NM: "LG" },
    { G_ID: "20260723SKLT0", GAME_STATE_SC: "2", AWAY_NM: "SSG", HOME_NM: "롯데" },
    { G_ID: "20260723HHHT0", GAME_STATE_SC: "2", AWAY_NM: "한화", HOME_NM: "KIA" },
    { G_ID: "20260723OBKT0", GAME_STATE_SC: "4", AWAY_NM: "두산", HOME_NM: "KT" },
    { G_ID: "20260723SSWO0", GAME_STATE_SC: "2", AWAY_NM: "삼성", HOME_NM: "키움" },
  ];
  const parsed = parseKboGameListPayload({ game: rows });
  return parsed?.length === 5 && parsed.filter((g) => g.GAME_STATE_SC === "2").length === 4;
})(), true);

// ---------------------------------------------------------------------------
// fast-loop 오케스트레이션 (삼순 blocker①②) — fake clock으로 절대 deadline/오류 분기 검증.
// ---------------------------------------------------------------------------
function checkNum(name: string, got: number, want: number) {
  if (got === want) { pass++; }
  else { fail++; console.error(`✗ ${name}: got ${got}, want ${want}`); }
}

const LIVE_GAME = {
  G_ID: "20260721LGOB0",
  GAME_STATE_SC: "2",
  AWAY_NM: "LG",
  HOME_NM: "두산",
  T_SCORE_CN: "1",
  B_SCORE_CN: "0",
  GAME_INN_NO: "4",
  GAME_TB_SC: "T",
  OUT_CN: "1",
  S_NM: "잠실",
} as unknown as KboRawGame;
const ENDED_GAME = { ...(LIVE_GAME as unknown as Record<string, unknown>), GAME_STATE_SC: "3" } as unknown as KboRawGame;

type FetchStep = { ok: boolean; games: KboRawGame[]; advanceMs?: number };
function makeLoopHarness(startAtMs: number, steps: FetchStep[]) {
  let t = startAtMs;
  let fetchCalls = 0;
  let pushCalls = 0;
  const sleeps: number[] = [];
  const deps: FastLoopDeps = {
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    fetchLiveGames: async () => {
      const step = steps[Math.min(fetchCalls, steps.length - 1)];
      fetchCalls++;
      if (step.advanceMs) t += step.advanceMs; // 느린 fetch 시뮬레이션
      return { ok: step.ok, games: step.games };
    },
    pushWidgets: async () => { pushCalls++; return { sent: 1 }; },
  };
  return { deps, counts: () => ({ fetchCalls, pushCalls }), sleeps, now: () => t };
}

async function runLoopTests() {
  checkNum("loop: 초기 push deadline은 요청+18s", initialWidgetPushDeadlineAt(1_000, 47_000), 19_000);
  check("loop: 초기 push deadline은 첫 fast tick보다 빠름",
    INITIAL_PUSH_DEADLINE_MS < FAST_LOOP_TARGETS_MS[0], true);
  checkNum("loop: 더 이른 전체 deadline을 넘지 않음", initialWidgetPushDeadlineAt(1_000, 15_000), 15_000);

  // 실제 route wiring 경계: fake clock이 +18s initial abort → +20s fast 최신 1건을 만든다.
  {
    let t = 0;
    let active = 0;
    let activeAtFast = -1;
    let initialAbortedAt = -1;
    const sendOrder: number[] = [];
    const timers: Array<{ at: number; run: () => void }> = [];
    const advanceTo = (target: number) => {
      for (;;) {
        const next = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.splice(timers.indexOf(next), 1);
        t = next.at;
        next.run();
      }
      t = target;
    };
    const pipelines = startWidgetRefreshPipelines({
      pushInitial: (_games, _baseUrl, opts) => {
        active = 1;
        const controller = new AbortController();
        return new Promise<{ sent: number }>((resolve) => {
          controller.signal.addEventListener("abort", () => {
            initialAbortedAt = t;
            active = 0;
            resolve({ sent: 0 });
          }, { once: true });
          timers.push({
            at: opts.deadlineAtMs,
            run: () => controller.abort(),
          });
        });
      },
      runFast: () => runWidgetFastLoop({
        now: () => t,
        sleep: async (ms) => { advanceTo(t + ms); },
        fetchLiveGames: async () => ({
          ok: true,
          games: [LIVE_GAME],
          trace: { sourceAtMs: 2_000, fetchedAtMs: 2_001 },
        }),
        pushWidgets: async (_games, trace) => {
          activeAtFast = active;
          sendOrder.push(trace.sourceAtMs);
          return { sent: 1 };
        },
      }, { requestStartMs: 0, targetsMs: [20_000], deadlineMs: 46_000 }),
    }, {
      requestStartMs: 0,
      overallDeadlineAtMs: 46_000,
      initial: { games: [LIVE_GAME], baseUrl: "http://smoke.local", sourceAtMs: 1_000, fetchedAtMs: 1_001 },
      initialSkipped: { sent: 0 },
    });
    await pipelines.fastPromise;
    advanceTo(46_000); // +46s 역변이도 pending initial을 정리해 assertion까지 도달시킨다.
    await pipelines.initialPromise;
    checkEq("loop: initial abort 후 fast 최신 1건만 발송", sendOrder.join(","), "2000");
    checkNum("loop: initial AbortSignal은 +18s에 발화", initialAbortedAt, 18_000);
    checkNum("loop: fast 시작 시 active initial 0", activeAtFast, 0);
    checkNum("loop: 종료 시 active 요청 0", active, 0);
  }

  // 정상: warmup 5s 소요 → +20/+40s tick 모두 실행 (요청 진입 기준).
  {
    const h = makeLoopHarness(5_000, [{ ok: true, games: [LIVE_GAME] }]);
    const ticks = await runWidgetFastLoop(h.deps, { requestStartMs: 0 });
    checkNum("loop: 정상 2 tick 실행", ticks.length, 2);
    checkNum("loop: push 2회", h.counts().pushCalls, 2);
    checkNum("loop: tick1은 요청+20s 시점", ticks[0].atMs, 20_000);
    checkNum("loop: tick2는 요청+40s 시점", ticks[1].atMs, 40_000);
  }
  // blocker①: 기존 warmup 작업이 47s 걸림(요청 진입 기준 deadline 46s 초과) → 루프 전체 미실행.
  {
    const h = makeLoopHarness(47_000, [{ ok: true, games: [LIVE_GAME] }]);
    const ticks = await runWidgetFastLoop(h.deps, { requestStartMs: 0 });
    checkNum("loop: deadline 초과 진입 → 0 tick", ticks.length, 0);
    checkNum("loop: deadline 초과 진입 → fetch 미시작", h.counts().fetchCalls, 0);
    checkNum("loop: deadline 초과 진입 → sleep 미시작", h.sleeps.length, 0);
  }
  // blocker①: warmup 30s 지연 → 지난 tick은 즉시, 다음 tick은 예정 시점에 — 모두 deadline 안.
  {
    const h = makeLoopHarness(30_000, [{ ok: true, games: [LIVE_GAME] }]);
    const ticks = await runWidgetFastLoop(h.deps, { requestStartMs: 0 });
    checkNum("loop: 30s 지연 → 2 tick(즉시+40s)", ticks.length, 2);
    checkNum("loop: 지난 tick은 sleep 없이 즉시", ticks[0].atMs, 30_000);
  }
  // blocker①: tick 목표 시점이 deadline 밖이면 sleep 자체를 안 한다(다음 크론과 겹침 방지).
  {
    const h = makeLoopHarness(0, [{ ok: true, games: [LIVE_GAME] }]);
    const ticks = await runWidgetFastLoop(h.deps, { requestStartMs: 0, deadlineMs: 30_000 });
    checkNum("loop: 목표 시점 > deadline → 해당 tick 생략", ticks.length, 1);
    checkNum("loop: 생략된 tick은 fetch 미시작", h.counts().fetchCalls, 1);
  }
  // blocker①: fetch가 deadline까지 소진하면 push(FCM/relay)를 시작하지 않는다.
  {
    const h = makeLoopHarness(5_000, [{ ok: true, games: [LIVE_GAME], advanceMs: 45_000 }]);
    const ticks = await runWidgetFastLoop(h.deps, { requestStartMs: 0 });
    checkNum("loop: 느린 fetch 후 deadline → push 미시작", h.counts().pushCalls, 0);
    checkNum("loop: 느린 fetch 후 deadline → 루프 종료", ticks.length, 0);
  }
  // blocker②: fetch 오류는 "라이브 0"이 아니다 → break 없이 다음 tick 재시도.
  {
    const h = makeLoopHarness(5_000, [
      { ok: false, games: [] },
      { ok: true, games: [LIVE_GAME] },
    ]);
    const ticks = await runWidgetFastLoop(h.deps, { requestStartMs: 0 });
    checkNum("loop: fetch 오류 → 다음 tick 재시도(2 tick)", ticks.length, 2);
    checkNum("loop: 오류 tick은 push 없음, 재시도 tick만 push", h.counts().pushCalls, 1);
    const errResult = ticks[0].result as { error?: string; retryNextTick?: boolean };
    check("loop: 오류 tick 결과에 retry 표시", errResult.error === "live_fetch_failed" && errResult.retryNextTick === true, true);
  }
  // blocker②: 정상 응답 + 라이브 0만 종료로 취급 → 이후 fetch/push 없음.
  {
    const h = makeLoopHarness(5_000, [{ ok: true, games: [ENDED_GAME] }]);
    const ticks = await runWidgetFastLoop(h.deps, { requestStartMs: 0 });
    checkNum("loop: 정상 응답 live 0 → 종료(0 tick 기록)", ticks.length, 0);
    checkNum("loop: live 0 종료 후 추가 fetch 없음", h.counts().fetchCalls, 1);
    checkNum("loop: live 0 → push 미실행", h.counts().pushCalls, 0);
  }
}

// ---------------------------------------------------------------------------
// pushAndroidWidgetLiveUpdates 주입 의존성 테스트 (삼순 blocker③④)
// ---------------------------------------------------------------------------
async function runPushTests() {
  const fcmCalls: Array<{ ids: string[]; prefKey?: string; platform?: string; deadlineAtMs?: number }> = [];
  const fansDeadlines: Array<number | undefined> = [];
  let fcmOk = true;
  let fcmRetryableFailed = 0;
  const sendFcmFake: typeof sendFcmToUsers = async (ids, _payload, prefKey, platform, opts) => {
    fcmCalls.push({ ids, prefKey, platform, deadlineAtMs: opts?.deadlineAtMs });
    return {
      tokens: ids.length,
      sent: fcmOk ? ids.length - fcmRetryableFailed : 0,
      failed: fcmOk ? fcmRetryableFailed : ids.length,
      cleaned: 0,
      skipped: 0,
      ok: fcmOk,
      retryableFailed: fcmRetryableFailed,
    };
  };
  const fansFake: typeof fansOfTeams = async (_teamIds, opts) => {
    fansDeadlines.push(opts?.deadlineAtMs);
    return { ids: ["fan1"], ok: true };
  };
  const fetchFail = (async () => ({ ok: false })) as unknown as typeof fetch; // relay 생략(줄만 안 뜩)
  const deps = { fansOfTeamsImpl: fansFake, sendFcmImpl: sendFcmFake, fetchImpl: fetchFail };

  // blocker③: FCM 인프라 실패(ok:false) → 시그니처 미기록 → 다음 사이클 동일 상태 재시도.
  __resetWidgetSigCacheForTest();
  fcmOk = false;
  await pushAndroidWidgetLiveUpdates([LIVE_GAME], "http://smoke.local", { dedupeAgainstLast: true }, deps);
  checkNum("push: 첫 사이클 FCM 시도", fcmCalls.length, 1);
  fcmOk = true;
  await pushAndroidWidgetLiveUpdates([LIVE_GAME], "http://smoke.local", { dedupeAgainstLast: true }, deps);
  checkNum("push: 직전 ok:false → 동일 상태 재시도(실패 dedupe 오염 없음)", fcmCalls.length, 2);
  const r3 = await pushAndroidWidgetLiveUpdates([LIVE_GAME], "http://smoke.local", { dedupeAgainstLast: true }, deps);
  checkNum("push: ok:true 기록 후 동일 상태 → skip(FCM 미호출)", fcmCalls.length, 2);
  checkNum("push: skip 카운트 반영", r3.skipped, 1);

  // partial transient 실패는 인프라 호출 자체가 ok여도 시그니처를 commit하지 않아 다음 tick 재시도.
  __resetWidgetSigCacheForTest();
  fcmRetryableFailed = 1;
  await pushAndroidWidgetLiveUpdates([LIVE_GAME], "http://smoke.local", { dedupeAgainstLast: true }, deps);
  const partialCalls = fcmCalls.length;
  fcmRetryableFailed = 0;
  await pushAndroidWidgetLiveUpdates([LIVE_GAME], "http://smoke.local", { dedupeAgainstLast: true }, deps);
  checkNum("push: partial transient 실패 → 동일 상태 다음 tick 재시도", fcmCalls.length, partialCalls + 1);

  // blocker④: 안드 위젯 data 푸시는 platform="android"로만 발송(iOS 토큰 제외).
  check("push: platform=android 전달", fcmCalls.every((c) => c.platform === "android"), true);
  check("push: prefKey=game_start 유지", fcmCalls.every((c) => c.prefKey === "game_start"), true);

  // blocker①: deadline 이미 도달 시 FCM/relay 시작 안 함.
  __resetWidgetSigCacheForTest();
  const before = fcmCalls.length;
  const rd = await pushAndroidWidgetLiveUpdates(
    [LIVE_GAME], "http://smoke.local", { dedupeAgainstLast: true, deadlineAtMs: Date.now() - 1 }, deps,
  );
  checkNum("push: deadline 경과 → FCM 미호출", fcmCalls.length, before);
  checkNum("push: deadline 경과 → 처리 경기 0", rd.games, 0);

  // 초기 Android 발송도 추가 tick과 같은 deadline을 fans→FCM까지 전달한다.
  __resetWidgetSigCacheForTest();
  const initialDeadline = Date.now() + 1_000;
  await pushAndroidWidgetLiveUpdates(
    [LIVE_GAME], "http://smoke.local", { deadlineAtMs: initialDeadline }, deps,
  );
  check("push: 초기 발송 fans query에 deadline 전달", fansDeadlines.at(-1) === initialDeadline, true);
  check("push: 초기 발송 FCM에 deadline 전달", fcmCalls.at(-1)?.deadlineAtMs === initialDeadline, true);
}

async function runBatchRetryTests() {
  const partial = await deliverTokenChunks(["ok", "transient", "invalid"], async () => ({
    successCount: 1,
    failureCount: 2,
    responses: [
      {},
      { error: { code: "messaging/server-unavailable" } },
      { error: { code: "messaging/registration-token-not-registered" } },
    ],
  }));
  checkNum("batch: transient 실패만 재시도 카운트", partial.retryableFailed, 1);
  checkNum("batch: invalid token 정리 카운트", partial.invalid.length, 1);

  const deadline = await deliverTokenChunks(
    ["a", "b", "c"],
    async () => { throw new Error("should-not-start"); },
    2,
    { deadlineAtMs: 100, now: () => 100 },
  );
  checkNum("batch: deadline 뒤 미시도 토큰 전부 retryable", deadline.retryableFailed, 3);
  check("batch: deadline 뒤 chunk 시작 안 함", deadline.lastError === "deadline_exceeded", true);

}

async function runAbortableFcmTransportTests() {
  let preAuthFetchCalls = 0;
  let authTimedOut = false;
  try {
    await sendDeadlineFcmChunk(
      ["a"],
      { data: { kind: "game_live" } },
      Date.now() + 10,
      {
        projectId: "smoke",
        getAccessToken: () => new Promise(() => {}),
        fetchImpl: (async () => { preAuthFetchCalls += 1; return new Response(); }) as typeof fetch,
      },
    );
  } catch (error) {
    authTimedOut = error instanceof Error && error.message === "deadline_exceeded";
  }
  check("fcm transport: auth hang은 deadline 오류", authTimedOut, true);
  checkNum("fcm transport: auth 미완료면 전송 시작 0", preAuthFetchCalls, 0);

  let active = 0;
  let aborted = 0;
  const hangingFetch = ((_url: URL | RequestInfo, init?: RequestInit) => {
    active += 1;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const onAbort = () => {
        active -= 1;
        aborted += 1;
        reject(new DOMException("aborted", "AbortError"));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }) as typeof fetch;
  const startedAt = Date.now();
  const timedOut = await sendDeadlineFcmChunk(
    ["a", "b", "c"],
    { data: { kind: "game_live" }, android: { priority: "HIGH", ttl: "90s" } },
    startedAt + 10,
    { projectId: "smoke", getAccessToken: async () => "token", fetchImpl: hangingFetch },
  );
  check("fcm transport: deadline에 실제 요청 3개 abort", aborted === 3, true);
  checkNum("fcm transport: 반환 시 active 요청 0", active, 0);
  checkNum("fcm transport: abort 3건 transient 실패", timedOut.failureCount, 3);
  check("fcm transport: deadline 내 반환", Date.now() - startedAt < 250, true);

  let body: { message?: Record<string, unknown> } | null = null;
  const okFetch = (async (_url: URL | RequestInfo, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}")) as { message?: Record<string, unknown> };
    return new Response(JSON.stringify({ name: "projects/smoke/messages/1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const success = await sendDeadlineFcmChunk(
    ["device-token"],
    { data: { kind: "game_live" }, android: { priority: "HIGH", collapse_key: "kbo_widget_stream", ttl: "90s" } },
    Date.now() + 1_000,
    { projectId: "smoke", getAccessToken: async () => "token", fetchImpl: okFetch },
  );
  checkNum("fcm transport: 정상 HTTP v1 성공", success.successCount, 1);
  check("fcm transport: token/payload 보존",
    body?.message?.token === "device-token"
      && (body?.message?.android as { collapse_key?: string })?.collapse_key === "kbo_widget_stream", true);
}

async function runKboFetchDeadlineTests() {
  const startedAt = Date.now();
  const neverFetch = (() => new Promise<Response>(() => {})) as typeof fetch;
  const result = await fetchKboLiveGames("20260722", startedAt + 10, neverFetch);
  check("kbo: 초기 fetch 무응답도 deadline에 반환", Date.now() - startedAt < 250, true);
  check("kbo: 초기 fetch timeout은 retryable ok:false", result.ok, false);
}

// ---------------------------------------------------------------------------
// fcm.ts token-query 회귀 (삼순 blocker④) — platform 인자가 device_push_tokens 쿼리에
// eq("platform", ...)로 반영되는지 supabase 싱글톤 monkey-patch로 검증(network 0).
// ---------------------------------------------------------------------------
async function runTokenQueryTests() {
  // getFcm() 초기화용 더미 서비스 계정(실서명 없음 — 토큰 0개라 발송/외부통신 없음).
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
    project_id: "smoke-test",
    client_email: "smoke@smoke-test.iam.gserviceaccount.com",
    private_key: privateKey,
  });

  const eqCalls: Array<{ table: string; col: string; val: unknown }> = [];
  const abortSignalCalls: string[] = [];
  let hangingActive = 0;
  let hangingAborted = 0;
  let hangingTable: string | null = null;
  const fakeFrom = (table: string) => {
    let querySignal: AbortSignal | undefined;
    const q = {
      select: () => q,
      in: () => q,
      eq: (col: string, val: unknown) => { eqCalls.push({ table, col, val }); return q; },
      gte: () => q,
      gt: () => q,
      order: () => q,
      limit: () => q,
      abortSignal: (signal: AbortSignal) => {
        querySignal = signal;
        abortSignalCalls.push(table);
        return q;
      },
      then: (
        resolve: (v: { data: unknown[]; error: null }) => void,
        reject: (reason: unknown) => void,
      ) => {
        if (hangingTable !== table) {
          resolve({ data: [], error: null });
          return;
        }
        hangingActive += 1;
        const onAbort = () => {
          hangingActive -= 1;
          hangingAborted += 1;
          reject(new DOMException("aborted", "AbortError"));
        };
        if (querySignal?.aborted) onAbort();
        else querySignal?.addEventListener("abort", onAbort, { once: true });
      },
    };
    return q;
  };
  (supabaseAdmin as unknown as { from: unknown }).from = fakeFrom;

  const payload = { title: "t", body: "b", dataOnly: true, data: { kind: "game_live" } };
  const withPlatform = await sendFcmToUsers(["u1"], payload, undefined, "android");
  check("fcm: platform=android → token query에 eq(platform, android)",
    eqCalls.some((c) => c.table === "device_push_tokens" && c.col === "platform" && c.val === "android"), true);
  check("fcm: 토큰 0개 정상 종료(ok:true)", withPlatform.ok, true);

  eqCalls.length = 0;
  await sendFcmToUsers(["u1"], payload, undefined);
  check("fcm: platform 미지정 → platform 필터 없음(iOS 포함 = 기존 동작)",
    eqCalls.some((c) => c.col === "platform"), false);

  hangingTable = "notification_prefs";
  const prefsStartedAt = Date.now();
  const prefsTimeout = await sendFcmToUsers(
    ["u1"], payload, "game_start", "android", { deadlineAtMs: prefsStartedAt + 10 },
  );
  check("fcm: 무응답 prefs query도 deadline에 반환", Date.now() - prefsStartedAt < 250, true);
  check("fcm: prefs timeout은 ok:false", prefsTimeout.ok, false);
  check("fcm: prefs timeout 오류 계약", prefsTimeout.lastError === "deadline_exceeded", true);
  check("fcm: prefs query에 AbortSignal 전달", abortSignalCalls.includes("notification_prefs"), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  checkNum("fcm: prefs timeout 뒤 active DB 요청 0", hangingActive, 0);
  checkNum("fcm: prefs timeout이 실제 DB 요청 abort", hangingAborted, 1);

  hangingTable = "device_push_tokens";
  const tokenStartedAt = Date.now();
  const tokenTimeout = await sendFcmToUsers(
    ["u1"], payload, undefined, "android", { deadlineAtMs: tokenStartedAt + 10 },
  );
  check("fcm: 무응답 token query도 deadline에 반환", Date.now() - tokenStartedAt < 250, true);
  check("fcm: token timeout은 ok:false", tokenTimeout.ok, false);
  check("fcm: token timeout 오류 계약", tokenTimeout.lastError === "deadline_exceeded", true);
}

(async () => {
  await runLoopTests();
  await runPushTests();
  await runBatchRetryTests();
  await runAbortableFcmTransportTests();
  await runKboFetchDeadlineTests();
  await runTokenQueryTests();
  console.log(`\nwidget-fast-refresh smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(1);
});
