// supabase/admin 싱글톤이 트랜지티브 로드 시점에 env 를 요구 — 다른 임포트보다 먼저.
import "./_smoke-env";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  canonicalizeForHash,
  channelsForTick,
  deserializeState,
  estimateMonthlyRealtimeMessages,
  frameHash,
  internalGetRequest,
  MAX_PAYLOAD_BYTES,
  newGameState,
  publishGameTick,
  RELAY_FRAME_FULL_EVERY,
  serializeState,
  VOLATILE_HASH_KEYS,
  type FrameRow,
  type PersistedGameState,
  type TickDeps,
} from "../../src/lib/game/relay-live-publisher";
import {
  parseFrameRow,
  RELAY_WATCHDOG_MS,
  shouldApplyFrame,
  shouldApplyPollResponse,
  shouldSuppressPoll,
} from "../../src/lib/game/relay-frames-client";

/**
 * qa:relay-realtime — 크관 relay Realtime 이관(B안) 계약 게이트.
 * 삼순 NO-GO(P0-1 구독 churn·P0-2 절감계약·P0-3 race·P1 단일writer) 반영 v2.
 *
 * 축:
 *  §1 수집기 — cadence·변경감지·full/delta·크기가드·재시도·seq회수·content-only·cron경계 지속
 *  §2 클라이언트 — fail-close 파싱·watchdog 억제·성공 baseline·단조 apply·generation fence
 *  §3 배선 — cron·vercel.json·migration·hook·실 Realtime E2E 스크립트
 */

const RELAY_DATA_A = {
  innings: [{ inning: 7, half: "top", plays: [{ text: "안타" }] }],
  linescore: { away: { R: 3 }, home: { R: 2 } },
};
const RELAY_DATA_B = {
  innings: [{ inning: 7, half: "top", plays: [{ text: "안타" }, { text: "홈런" }] }],
  linescore: { away: { R: 5 }, home: { R: 2 } },
};

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function depsWith(overrides: {
  relayData?: () => unknown;
  insertResult?: boolean;
  rows?: FrameRow[];
}): TickDeps & { rows: FrameRow[] } {
  const rows: FrameRow[] = overrides.rows ?? [];
  const relayData = overrides.relayData ?? (() => RELAY_DATA_A);
  return {
    handlers: {
      relay: async () => jsonResponse(relayData()),
      events: async () => jsonResponse({ events: [] }),
      live: async () => jsonResponse({ games: [] }),
      detail: async () => jsonResponse({ detail: true }),
    },
    insertFrame: async (row) => {
      if (overrides.insertResult === false) return false;
      rows.push(row);
      return true;
    },
    date: "2026-08-25",
    rows,
  } as TickDeps & { rows: FrameRow[] };
}

// ───────────────────────────── §1 수집기 ─────────────────────────────

test("§1 tick cadence — relay 매 tick, events 15s, live 9s, detail 30s grid", () => {
  assert.deepEqual(channelsForTick(0), ["relay", "events", "live", "detail"]);
  assert.deepEqual(channelsForTick(1), ["relay"]);
  assert.deepEqual(channelsForTick(3), ["relay", "live"]);
  assert.deepEqual(channelsForTick(5), ["relay", "events"]);
  assert.deepEqual(channelsForTick(10), ["relay", "events", "detail"]);
});

test("§1 첫 발행은 relay-full, 무변경 tick 은 relay INSERT 0 (content-only)", async () => {
  const deps = depsWith({});
  const state = newGameState();
  const first = await publishGameTick(deps, state, "20260825LGHH0", 1);
  assert.equal(first.inserted, 1);
  assert.equal(deps.rows[0].kind, "relay-full");

  const second = await publishGameTick(deps, state, "20260825LGHH0", 2);
  assert.equal(second.inserted, 0);
  assert.equal(second.skippedUnchanged, 1);
});

test("§1 변경 시 delta + seq 단조, FULL_EVERY 주기로 full 재발행", async () => {
  let data: unknown = RELAY_DATA_A;
  const deps = depsWith({ relayData: () => data });
  const state = newGameState();
  await publishGameTick(deps, state, "g1", 1);

  data = RELAY_DATA_B;
  await publishGameTick(deps, state, "g1", 2);
  assert.equal(deps.rows.length, 2);
  assert.equal(deps.rows[1].kind, "relay-delta");
  assert.ok(deps.rows[1].seq > deps.rows[0].seq);
  assert.equal((deps.rows[1].payload.data as { partial?: boolean }).partial, true);

  for (let i = 0; i < RELAY_FRAME_FULL_EVERY; i++) {
    data = { ...RELAY_DATA_B, tick: i };
    await publishGameTick(deps, state, "g1", 3 + i);
  }
  const fulls = deps.rows.filter((r) => r.kind === "relay-full").length;
  assert.ok(fulls >= 2, `주기적 full 재발행 필요 (fulls=${fulls})`);
});

test("§1 INSERT 실패 시 hash·seq 불변 — 다음 tick 재시도(fail-closed)", async () => {
  const failDeps = depsWith({ insertResult: false });
  const state = newGameState();
  const first = await publishGameTick(failDeps, state, "g1", 1);
  assert.equal(first.inserted, 0);
  assert.equal(first.errors.length, 1);
  // 삼순 5차: async 경계 뒤 seq 감산 금지 → 실패 seq 는 회수되지 않고 전진한다(gap 허용).
  assert.equal(state.seq, 1, "실패해도 seq 는 단조증가(되감지 않음)");
  assert.equal(Object.keys(state.lastHash).length, 0, "실패면 hash 미갱신");

  const okDeps = depsWith({});
  const second = await publishGameTick(okDeps, state, "g1", 2);
  assert.equal(second.inserted, 1, "실패 프레임은 다음 tick 재발행");
  // 재시도는 이전 실패 seq(1) 재사용 없이 더 큰 seq(2)로 — 단조 보장.
  assert.equal(state.seq, 2, "재시도는 더 큰 seq 로 — 단조 보장");
});

test("§1 크기 가드 — MAX_PAYLOAD_BYTES 초과 프레임은 INSERT 안 함", async () => {
  const huge = { innings: [{ inning: 1, big: "x".repeat(MAX_PAYLOAD_BYTES) }] };
  const deps = depsWith({ relayData: () => huge });
  const state = newGameState();
  const result = await publishGameTick(deps, state, "g1", 1);
  assert.equal(result.inserted, 0);
  assert.equal(result.skippedOversize, 1);
});

test("§1 handler 실패(비 2xx)는 프레임 미기록 + 에러 집계", async () => {
  const deps = depsWith({});
  deps.handlers.relay = async () => new Response("down", { status: 503 });
  const state = newGameState();
  const result = await publishGameTick(deps, state, "g1", 1);
  assert.equal(result.inserted, 0);
  assert.ok(result.errors.some((e) => e.includes("relay")));
});

// 삼순 2차 P0 비용: canonical hash — volatile trace 제거
test("§1 canonical hash — volatile trace(sourceAtMs 등)가 바뀌어도 무변경이면 INSERT 0", async () => {
  // game-live 형 응답: sourceAtMs/fetchedAtMs/deadlineAtMs 가 매 tick 바뀌지만 내용은 동일
  let liveTs = 100;
  const liveData = () => ({ games: [{ gameId: "g1", score: "3:2" }], trace: { stage: "ok" }, sourceAtMs: liveTs, fetchedAtMs: liveTs + 1, deadlineAtMs: liveTs + 999 });
  const deps = depsWith({});
  deps.handlers.live = async () => jsonResponse(liveData());
  const state = newGameState();

  // tick 0 = 전채널: live 첫 발행
  await publishGameTick(deps, state, "g1", 0);
  const liveInsertsAfterFirst = deps.rows.filter((r) => r.kind === "live").length;
  assert.equal(liveInsertsAfterFirst, 1);

  // 이후 live tick(3,6,9)에서 timestamp 만 바뀜 → canonical hash 동일 → INSERT 0
  for (const t of [3, 6, 9]) {
    liveTs += 9_000; // volatile 만 변화
    await publishGameTick(deps, state, "g1", t);
  }
  const liveInsertsTotal = deps.rows.filter((r) => r.kind === "live").length;
  assert.equal(liveInsertsTotal, 1, "volatile trace 만 바뀌면 live 재발행 0 이어야 한다");
});

test("§1 canonicalizeForHash — volatile 키 재귀 제거, 실제 변경은 반영", () => {
  assert.ok(VOLATILE_HASH_KEYS.has("sourceAtMs") && VOLATILE_HASH_KEYS.has("trace"));
  const a = { x: 1, sourceAtMs: 100, nested: { y: 2, fetchedAtMs: 5 } };
  const b = { x: 1, sourceAtMs: 999, nested: { y: 2, fetchedAtMs: 88 } };
  assert.equal(frameHash(a), frameHash(b), "volatile 만 다르면 동일 hash");
  const c = { x: 2, sourceAtMs: 100, nested: { y: 2, fetchedAtMs: 5 } };
  assert.notEqual(frameHash(a), frameHash(c), "실제 값이 다르면 상이 hash");
  assert.equal(JSON.stringify(canonicalizeForHash(a)), JSON.stringify(canonicalizeForHash(b)));
});

// B2: content-only 라 실패/oversize tick 은 어떤 프레임도 안 낸다. heartbeat 로 실패를
// 가리던 역전이 원천 소멸 — 클라 watchdog 이 신선도 두절로 자동 폴백한다.
test("§1 폴백 역전 소멸 — fetch 실패·oversize tick 은 발행 0 (마스킹 프레임 없음)", async () => {
  const deps = depsWith({});
  const state = newGameState();
  await publishGameTick(deps, state, "g1", 1);

  deps.handlers.relay = async () => new Response("down", { status: 503 });
  for (const t of [2, 4]) {
    const r = await publishGameTick(deps, state, "g1", t);
    assert.equal(r.inserted, 0, "실패 tick 은 발행 0");
    assert.ok(r.errors.length > 0);
  }

  const huge = { innings: [{ inning: 1, big: "x".repeat(MAX_PAYLOAD_BYTES) }] };
  const deps2 = depsWith({ relayData: () => huge });
  const state2 = newGameState();
  const r2 = await publishGameTick(deps2, state2, "g1", 1);
  assert.equal(r2.inserted, 0, "oversize tick 은 발행 0");
  assert.equal(r2.skippedOversize, 1);
});

// 삼순 5차 실행 결함주입: A deferred insert → abort → B(new) commit → A(old) release.
// 실제 route 의 insertFrame 은 ownsLock(async) 뒤 abort 를 재확인해 abort 된 A 는 커밋하지
// 않는다. 이를 모델링한 insertFrame(공용 DB id 카운터) 위에서, A 가 INSERT 대기 중 abort 되고
// 그 사이 B 가 먼저 커밋한 뒤 A 가 release 돼도: (1) A row 는 DB 에 안 남고 (2) 최종 최신 row 는
// B (3) 공용 seq 는 단조(A 의 감산으로 B seq 가 되감기지 않음) 임을 함께 고정한다.
// (post-async seq 감산을 되살리거나 insertFrame 의 abort 재확인을 빼면 이 테스트는 RED.)
test("§1 abort/overlap fence — A deferred→abort→B commit→A release: A 미커밋·최신=B·seq 단조", async () => {
  const db: FrameRow[] = [];       // 공용 DB (id = 삽입 순서)
  let releaseA!: () => void;
  const aGate = new Promise<void>((r) => { releaseA = r; });
  const state = newGameState();     // A/B 공용 state (같은 경기)
  const acA = new AbortController();

  // route 의 insertFrame 계약을 모델링: signal.aborted 면 커밋하지 않는다(async 경계 뒤 재확인).
  const makeDeps = (gate?: Promise<void>): TickDeps => ({
    handlers: {
      relay: async () => jsonResponse(gate === aGate ? RELAY_DATA_A : RELAY_DATA_B),
      events: async () => jsonResponse({ events: [] }),
      live: async () => jsonResponse({ games: [] }),
      detail: async () => jsonResponse({ detail: true }),
    },
    insertFrame: async (row, signal) => {
      if (gate) await gate;             // A 는 gate 에 걸려 대기
      if (signal?.aborted) return false; // ownsLock 뒤 abort 재확인 계약
      db.push(row);
      return true;
    },
    date: "2026-08-25",
  });

  // A 시작(gate 에 걸림)
  const aPromise = publishGameTick(makeDeps(aGate), state, "g1", 1, acA.signal);
  await new Promise((r) => setTimeout(r, 10));
  // A 를 abort(timeout 모델)
  acA.abort();
  // B(new) 가 먼저 커밋 — non-overlap 상황이 깨진 최악 케이스를 강제 재현
  const acB = new AbortController();
  await publishGameTick(makeDeps(), state, "g1", 2, acB.signal);
  // 이제 A release
  releaseA();
  await aPromise;

  // (1) A row 는 커밋되지 않았다(abort 재확인).
  assert.ok(!db.some((r) => JSON.stringify(r.payload.data) === JSON.stringify(RELAY_DATA_A)),
    "abort 된 A 는 DB 에 커밋되지 않아야 한다");
  // (2) 최신(마지막) row 는 B.
  assert.ok(db.length >= 1, "B 는 커밋됐어야 한다");
  assert.equal(JSON.stringify(db[db.length - 1].payload.data), JSON.stringify(RELAY_DATA_B), "최신 row=B");
  // (3) 공용 seq 는 단조 — B 커밋 후 A release 가 seq 를 되감지 않았다.
  const seqs = db.map((r) => r.seq);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], `seq 단조 (idx ${i}: ${seqs[i - 1]}→${seqs[i]})`);
});

// 삼순 4차 ③ 실행 결함주입: abort 이후 남은 채널은 아예 INSERT 를 시도하지 않는다.
// (pre-INSERT signal.aborted 가드 제거 시 RED — abort 후에도 다음 채널이 INSERT 됨.)
test("§1 abort fence — abort 이후 채널은 INSERT 시도조차 안 함", async () => {
  const rows: FrameRow[] = [];
  const ac = new AbortController();
  const deps: TickDeps = {
    handlers: {
      // tick 0 = 전채널. relay 에서 abort 를 유발한 뒤 events/live/detail 은 스킵돼야 한다.
      relay: async () => { ac.abort(); return jsonResponse(RELAY_DATA_A); },
      events: async () => jsonResponse({ events: [{ id: "e1" }] }),
      live: async () => jsonResponse({ games: [{ x: 1 }] }),
      detail: async () => jsonResponse({ detail: true }),
    },
    insertFrame: async (row) => { rows.push(row); return true; },
    date: "2026-08-25",
  };
  const state = newGameState();
  const result = await publishGameTick(deps, state, "g1", 0, ac.signal);
  assert.equal(rows.length, 0, "abort 후 어떤 채널도 INSERT 하지 않아야 한다");
  assert.equal(result.inserted, 0);
});

// 삼순 4차 P0 비용 — dual gate. 단일 26M 손익분기 PASS 금지. 세 축을 각각 판정:
//  (a) 포함량: Pro Realtime 무료 포함은 월 500만 메시지. 기존 chat + relay 합산이
//      이를 넘으면 그때부터 과금. (b) 초과분 실제 요금: 초과 메시지 × 단가($2.5/백만)로
//      실 달러 산출 → 절감 목표(월 $20~30) 내여야 우위. (c) watchdog Edge 상한:
//      content-only 라 idle 도 watchdog poll 이 있으므로 Edge 요청이 0 이 아니다 — 그
//      상한을 결정론적으로 계산해 기존 3초 폴링 대비 절감률을 판정한다.
const PRO_REALTIME_INCLUDED = 5_000_000;        // Pro 플랜 월 포함 메시지
const REALTIME_OVERAGE_USD_PER_M = 2.5;          // 초과분 백만 메시지당 $ (Supabase Pro)
const EXISTING_CHAT_MONTHLY = 3_000_000;         // 7/31 실측 기반 보수 추정(chat Realtime)
const RELAY_SAVINGS_TARGET_USD = 30;             // B2 로 아껴야 하는 월 Vercel edge 달러(최소 목표)

function realtimeOverageUsd(chatMonthly: number, relayMonthly: number): number {
  const total = chatMonthly + relayMonthly;
  const overage = Math.max(0, total - PRO_REALTIME_INCLUDED);
  return (overage / 1_000_000) * REALTIME_OVERAGE_USD_PER_M;
}

// watchdog Edge 상한: 무변경 idle 구간에도 watchdog poll 이 도는 최악 요청 수.
// (라이브 분 / watchdog 분) × CCU × 경기수 × 일수. 3초 폴링은 (라이브분×20) × ... 이므로
// 절감률 = 1 - watchdog/폴링.
function watchdogEdgeMonthly(p: { liveMinutesPerDayPerGame: number; avgConcurrentViewers: number; gamesPerDay: number; watchdogMs: number }): number {
  const pollsPerMin = 60_000 / p.watchdogMs;
  return pollsPerMin * p.liveMinutesPerDayPerGame * p.avgConcurrentViewers * p.gamesPerDay * 30;
}
function pollingEdgeMonthly(p: { liveMinutesPerDayPerGame: number; avgConcurrentViewers: number; gamesPerDay: number; pollMs: number }): number {
  const pollsPerMin = 60_000 / p.pollMs;
  return pollsPerMin * p.liveMinutesPerDayPerGame * p.avgConcurrentViewers * p.gamesPerDay * 30;
}

test("§1 비용 dual gate (a) 포함량 — content-only relay + 기존 chat 이 Pro 포함 5M 관계를 명시", () => {
  const SHADOW = { framesPerMinutePerGame: 8, avgConcurrentViewers: 100, liveMinutesPerDayPerGame: 180, gamesPerDay: 5 };
  const relay = estimateMonthlyRealtimeMessages(SHADOW);
  assert.equal(relay, SHADOW.framesPerMinutePerGame * SHADOW.avgConcurrentViewers * SHADOW.liveMinutesPerDayPerGame * SHADOW.gamesPerDay * 30);
  // shadow 가정으로는 relay 21.6M → chat 합산이 포함량을 초과하므로 (b) 초과요금 축이 실제 판정.
  // 여기서는 포함량 대비 초과 여부를 명시적으로 계산해 착시(포함 내 무료로 오판)를 차단.
  const total = relay + EXISTING_CHAT_MONTHLY;
  const exceedsIncluded = total > PRO_REALTIME_INCLUDED;
  assert.equal(exceedsIncluded, true, "shadow 가정에선 포함량 초과 — (b) 초과요금으로 판정해야 한다");
});
test("§1 비용 dual gate (b-산식) 초과요금 계산이 정확하다 — 포함량 차감×단가 (결정론)", () => {
  // 산식 자체는 결정론적으로 항상 검증한다(포함 5M 미만=$0, 초과만 과금).
  assert.equal(realtimeOverageUsd(1_000_000, 1_000_000), 0, "합산이 포함량 미만이면 $0");
  // 합산 9M → 초과 4M × $2.5/M = $10
  assert.equal(realtimeOverageUsd(3_000_000, 6_000_000), 10, "초과 4M × $2.5 = $10");
});
// (b-판정) 비용 우위는 shadow 실측 입력이 있을 때만 판정한다. 추측 값으로 GO 금지 —
// SHADOW_MEASURED=1 과 실측 env(SHADOW_FPM·SHADOW_CCU) 가 있을 때만 초과요금을 목표와 대조.
// 실측 전에는 "미입증(unproven)"으로 남겨 CI 를 추측으로 깨뜨리지 않고, cutover 승인 전제로 만 연결한다.
test("§1 비용 dual gate (b-판정) shadow 실측 있을 때만 초과요금을 목표와 대조 (추측 GO 금지)", () => {
  const measured = process.env.SHADOW_MEASURED === "1";
  if (!measured) {
    // 실측 전: 비용 우위 미입증. 이 플래그를 cutover 전제로 기록하고 CI 는 통과(추측으로 깨지 않음).
    assert.equal(measured, false, "shadow 미입증 — 비용 우위는 cutover 승인 전제(추측으로 GO 불가)");
    return;
  }
  const fpm = Number(process.env.SHADOW_FPM);
  const ccu = Number(process.env.SHADOW_CCU);
  assert.ok(Number.isFinite(fpm) && Number.isFinite(ccu), "SHADOW_FPM·SHADOW_CCU 실측값 필요");
  const relay = estimateMonthlyRealtimeMessages({ framesPerMinutePerGame: fpm, avgConcurrentViewers: ccu, liveMinutesPerDayPerGame: 180, gamesPerDay: 5 });
  const usd = realtimeOverageUsd(EXISTING_CHAT_MONTHLY, relay);
  assert.ok(usd <= RELAY_SAVINGS_TARGET_USD,
    `실측 초과요금 $${usd.toFixed(2)} 가 절감목표 $${RELAY_SAVINGS_TARGET_USD} 내여야 cutover 우위`);
});
test("§1 비용 dual gate (c) watchdog Edge 상한 — 3초 폴링 대비 절감률 80% 이상", () => {
  const base = { liveMinutesPerDayPerGame: 180, avgConcurrentViewers: 100, gamesPerDay: 5 };
  // 삼순 4차 P1: 하드코딩 45_000 대신 런타임 상수 RELAY_WATCHDOG_MS 를 직접 사용해
  // 상수 회귀(예: 주기를 3초로 낮추면 절감 소멸)를 게이트가 잡게 한다.
  const watchdog = watchdogEdgeMonthly({ ...base, watchdogMs: RELAY_WATCHDOG_MS });
  const polling = pollingEdgeMonthly({ ...base, pollMs: 3_000 });
  const reduction = 1 - watchdog / polling;
  assert.ok(reduction >= 0.8, `watchdog(${RELAY_WATCHDOG_MS}ms) 이 3초 폴링 대비 ${(reduction * 100).toFixed(1)}% 절감(≥80% 요구)`);
  // 상수가 3초 이하로 회귀하면 이 게이트가 RED 임을 명시(검출력).
  assert.ok(RELAY_WATCHDOG_MS >= 30_000, `watchdog 상수는 30~60초 범위여야 한다(현 ${RELAY_WATCHDOG_MS}ms)`);
});
test("§1 비용 dual gate 검출력 — heartbeat 부하(34/분)면 초과요금이 목표 초과로 RED", () => {
  const relay = estimateMonthlyRealtimeMessages({ framesPerMinutePerGame: 34, avgConcurrentViewers: 100, liveMinutesPerDayPerGame: 180, gamesPerDay: 5 });
  const usd = realtimeOverageUsd(EXISTING_CHAT_MONTHLY, relay);
  assert.ok(usd > RELAY_SAVINGS_TARGET_USD, `heartbeat 부하 초과요금 $${usd.toFixed(2)} 는 목표 초과여야 검출력 있음`);
});

// B2 content-only: 무변경이 아무리 길어도 heartbeat 없이 발행 0 (edge 는 클라 watchdog)
test("§1 content-only — 무변경이 길어도 heartbeat 없이 발행 0", async () => {
  const deps = depsWith({});
  const state = newGameState();
  await publishGameTick(deps, state, "g1", 1); // relay-full 발행
  const baseRows = deps.rows.length;
  for (const t of [2, 4, 7, 8, 11]) {
    const r = await publishGameTick(deps, state, "g1", t);
    assert.equal(r.inserted, 0);
  }
  assert.equal(deps.rows.length, baseRows, "무변경 구간엔 어떤 프레임도 추가 발행되지 않아야 한다(heartbeat 폐기)");
  assert.equal(deps.rows.filter((x) => (x.kind as string) === "heartbeat").length, 0);
});

// P1 반영: cron 경계 상태 지속
test("§1 cron 경계 — 상태 직렬화→역직렬화 후 재개 시 무변경 재발행 0", async () => {
  const deps1 = depsWith({});
  const state = newGameState();
  await publishGameTick(deps1, state, "g1", 0); // full + events/live/detail (tick 0 = 전채널)
  const insertedFirst = deps1.rows.length;
  assert.ok(insertedFirst >= 1);

  // 인보케이션 종료 → Redis 저장 시뮬
  const persisted = serializeState(state);

  // 다음 인보케이션: 상태 로드, 동일 데이터
  const restored: PersistedGameState = deserializeState(persisted);
  const deps2 = depsWith({});
  const r = await publishGameTick(deps2, restored, "g1", 0);
  assert.equal(r.inserted, 0, "cron 경계 넘어 무변경이면 재발행 0 (P1)");
  assert.ok(r.skippedUnchanged >= 1);
});

test("§1 deserializeState — 깨진 입력은 fresh 상태로 fail-safe", () => {
  assert.deepEqual(deserializeState("not-json"), newGameState());
  assert.deepEqual(deserializeState(null), newGameState());
  const s = deserializeState(serializeState({ lastHash: { relay: "h" }, relayChanges: 3, seq: 9, publishedFull: true }));
  assert.equal(s.seq, 9);
  assert.equal(s.relayChanges, 3);
  assert.equal(s.publishedFull, true);
});

test("§1 frameHash — 동일 내용 동일, 한 글자라도 다르면 상이", () => {
  assert.equal(frameHash(RELAY_DATA_A), frameHash(JSON.parse(JSON.stringify(RELAY_DATA_A))));
  assert.notEqual(frameHash(RELAY_DATA_A), frameHash(RELAY_DATA_B));
});

test("§1 internalGetRequest — 파라미터가 URL 에 실린다", () => {
  const req = internalGetRequest("/api/game-relay", { gameId: "g1", inning: "7" });
  assert.ok(req instanceof NextRequest);
  assert.equal(req.nextUrl.searchParams.get("gameId"), "g1");
});

// ───────────────────────────── §2 클라이언트 ─────────────────────────────

const VALID_ROW = {
  id: 10,
  game_id: "g1",
  seq: 3,
  kind: "relay-delta",
  payload: { channel: "relay", ok: true, status: 200, data: RELAY_DATA_A },
};

test("§2 parseFrameRow — 정상 row 통과", () => {
  const row = parseFrameRow(VALID_ROW, "g1");
  assert.ok(row);
  assert.equal(row.kind, "relay-delta");
});

test("§2 parseFrameRow — content-only: heartbeat kind 는 미지 kind 로 거부", () => {
  const hb = { id: 11, game_id: "g1", seq: 4, kind: "heartbeat", payload: { channel: "relay", ok: true, status: 204, data: { heartbeat: true } } };
  assert.equal(parseFrameRow(hb, "g1"), null, "heartbeat 폐기 — 미지 kind 로 fail-close");
});

test("§2 parseFrameRow fail-close — 결측·불일치·미지 kind·빈 payload·data결측 null", () => {
  assert.equal(parseFrameRow(null, "g1"), null);
  assert.equal(parseFrameRow({ ...VALID_ROW, game_id: "g2" }, "g1"), null);
  assert.equal(parseFrameRow({ ...VALID_ROW, kind: "unknown" }, "g1"), null);
  assert.equal(parseFrameRow({ ...VALID_ROW, payload: null }, "g1"), null);
  assert.equal(parseFrameRow({ ...VALID_ROW, payload: { channel: "relay", ok: false, status: 503, data: {} } }, "g1"), null);
  assert.equal(parseFrameRow({ ...VALID_ROW, payload: { channel: "relay", ok: true, status: 200 } }, "g1"), null, "relay 는 data 결측 차단");
});

// B2 watchdog: 무변경(프레임 0) 2분 구간 — edge poll 이 watchdog 주기로 상한된다
test("§2 watchdog — 무변경 2분 idle edge poll 이 (경과/watchdog) 상한 이내", () => {
  const start = 5_000_000;
  let lastFresh = start; // baseline 직후, 이후 무변경(프레임 0)
  let pollCount = 0;
  for (let t = start + 1_000; t <= start + 120_000; t += 1_000) {
    const suppress = shouldSuppressPoll({ lastRelayFreshAtMs: lastFresh, nowMs: t, hasRelayBaseline: true });
    if (!suppress) {
      pollCount += 1;
      lastFresh = t; // 성공 watchdog poll 이 신선도 갱신 → 다시 억제 구간
    }
  }
  const cap = Math.ceil(120_000 / RELAY_WATCHDOG_MS);
  assert.ok(pollCount >= 1 && pollCount <= cap, `idle 2분 edge poll ${pollCount} 이 상한 ${cap} 이내여야 한다`);
  assert.ok(pollCount < 40, "3초 폴링(약 120회) 대비 대폭 감소");
});

test("§2 Realtime 두절 시 watchdog poll 자동 재개", () => {
  const start = 6_000_000;
  const lastFresh = start; // 이후 프레임 두절
  let resumedAt: number | null = null;
  for (let t = start; t <= start + 90_000; t += 1_000) {
    const suppress = shouldSuppressPoll({ lastRelayFreshAtMs: lastFresh, nowMs: t, hasRelayBaseline: true });
    if (!suppress && resumedAt === null) resumedAt = t - start;
  }
  assert.ok(resumedAt !== null && resumedAt >= RELAY_WATCHDOG_MS && resumedAt <= RELAY_WATCHDOG_MS + 1_000,
    `두절 후 watchdog(${RELAY_WATCHDOG_MS}ms) 경과에 poll 재개 (resumed=${resumedAt})`);
});

test("§2 baseline 전(성공 relay 미보유)엔 신선해도 항상 폴링 (삼순 3차)", () => {
  const now = 1_000_000;
  assert.equal(shouldSuppressPoll({ lastRelayFreshAtMs: now - 1_000, nowMs: now, hasRelayBaseline: false }), false);
});

test("§2 shouldApplyFrame — 전역 id 단조 가드", () => {
  assert.equal(shouldApplyFrame(0, 1), true);
  assert.equal(shouldApplyFrame(5, 5), false);
  assert.equal(shouldApplyFrame(5, 4), false);
  assert.equal(shouldApplyFrame(5, 6), true);
});

// P0-3 반영: generation fence
test("§2 generation fence — 느린 poll 이 최신 Realtime 을 과거로 덮지 못한다", () => {
  // poll 이 generation 0 에서 시작
  const pollGen = 0;
  // 응답 도착 전 Realtime 이 최신 프레임 2개 적용 → generation 2
  const currentGen = 2;
  assert.equal(shouldApplyPollResponse(pollGen, currentGen), false, "낡은 poll 응답은 버려진다");
  // Realtime 이 개입 안 했으면(동일 generation) poll 적용
  assert.equal(shouldApplyPollResponse(1, 1), true);
  assert.equal(shouldApplyPollResponse(3, 2), true, "poll 이 더 최신이면 적용");
});

// ───────────────────────────── §3 배선 ─────────────────────────────

const worktreeRoot = join(__dirname, "..", "..");
function readSrc(rel: string): string {
  return readFileSync(join(worktreeRoot, rel), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("§3 cron route — handler 4종·퍼블리셔·Redis 락·상태 지속·fail-close 배선", () => {
  const src = readSrc("src/app/api/cron/relay-live-publisher/route.ts");
  assert.ok(/from "@\/app\/api\/game-relay\/route"/.test(src));
  assert.ok(/publishGameTick/.test(src));
  assert.ok(/acquireLock/.test(src) && /releaseLock/.test(src) && /renewLock/.test(src), "토큰 락 renew/compare-delete");
  assert.ok(/deserializeState/.test(src) && /serializeState/.test(src), "상태 지속");
  assert.ok(/Redis 미설정[\s\S]*503/.test(src) || /redisConfig\(\)\)\s*\{[\s\S]*503/.test(src), "Redis fail-close");
  assert.ok(/game_relay_frames/.test(src));
});

test("§3 vercel.json — 1분 cron 정확히 1개", () => {
  const vercel = JSON.parse(readFileSync(join(worktreeRoot, "vercel.json"), "utf-8")) as {
    crons: Array<{ path: string; schedule: string }>;
  };
  const hits = vercel.crons.filter((c) => c.path === "/api/cron/relay-live-publisher");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].schedule, "* * * * *");
});

test("§3 migration — 테이블·RLS·publication·content-only kind·write정책 부재", () => {
  const sql = readFileSync(join(worktreeRoot, "supabase/migrations/20260825020000_game_relay_frames.sql"), "utf-8")
    .replace(/^\s*--.*$/gm, "");
  assert.ok(/create table public\.game_relay_frames/.test(sql));
  assert.ok(/enable row level security/.test(sql));
  assert.ok(/alter publication supabase_realtime add table public\.game_relay_frames/.test(sql));
  assert.ok(!/heartbeat/.test(sql), "content-only: heartbeat kind 없음");
  assert.ok(!/create policy[\s\S]*for (insert|update|delete)/i.test(sql), "write 정책 없음 = service_role 전용");
});

test("§3 route lease — 독립 renewal·lockLost INSERT 차단·저장 직전 소유권 재확인(삼순 3차)", () => {
  const src = readSrc("src/app/api/cron/relay-live-publisher/route.ts");
  assert.ok(/setInterval\(\(\) => \{[\s\S]*renewLock\(token\)/.test(src), "tick 독립 renewal 타이머");
  assert.ok(/clearInterval\(renewTimer\)/.test(src), "renewal 타이머 정리");
  // 삼순 5차: INSERT 차단은 lockLost 또는 signal.aborted — 둘 다 있어야 한다.
  assert.ok(/if \(lockLost \|\| signal\?\.aborted\) return false;/.test(src), "락 상실/abort 시 INSERT 차단(old writer)");
  // 삼순 5차: ownsLock(async) 뒤 abort 재확인 + Supabase insert 에 abortSignal.
  assert.ok(/if \(!\(await ownsLock\(token\)\)\)[\s\S]*if \(signal\?\.aborted\) return false;/.test(src), "ownsLock 뒤 abort 재확인");
  assert.ok(/\.abortSignal\(signal\)/.test(src), "Supabase insert 에 abortSignal 전달");
  assert.ok(/const stillOwner = !lockLost && \(await renewLock\(token\)\);/.test(src), "저장 직전 소유권 재확인");
  assert.ok(/if \(stillOwner\)[\s\S]*SET", stateKey/.test(src), "소유일 때만 state 저장");
  assert.ok(/Promise\.race<TickResult>/.test(src), "tick handler timeout");
  // 삼순 5차: 같은 경기 non-overlap — in-flight 중이면 skip.
  assert.ok(/inFlight\.has\(gameId\)[\s\S]*overlap-skip/.test(src), "같은 경기 non-overlap 가드");
  assert.ok(/inFlight\.add\(gameId\)[\s\S]*settle\.finally\(\(\) => inFlight\.delete\(gameId\)\)/.test(src), "진짜 settle 시 in-flight 해제");
  assert.ok(/redis\.call\('del'/.test(src), "compare-delete 해제");
});

test("§3 useGameRelay — 구독·억제·단조·generation·callback ref 배선(P0-1/2/3)", () => {
  const src = readSrc("src/lib/hooks/useGameRelay.ts");
  assert.ok(/postgres_changes/.test(src) && /game_relay_frames/.test(src));
  assert.ok(/shouldSuppressPoll/.test(src), "폴링 억제");
  assert.ok(/parseFrameRow/.test(src), "fail-close 파싱");
  assert.ok(/shouldApplyFrame/.test(src), "단조 가드");
  assert.ok(/shouldApplyPollResponse/.test(src) && /relayGenerationRef/.test(src), "P0-3 generation fence");
  // 삼순 4차 ②: 채널별 fence 분리. relay/live/detail 이 각자의 generation ref 를 갖고,
  // applyFrame 은 전달받은 genRef/genSnapshot 으로 판정해야 한다(공용 relayGenerationRef 직참조 ❌).
  assert.ok(/liveGenerationRef/.test(src) && /detailGenerationRef/.test(src), "삼순 4차 ② 채널별 generation ref");
  const applyFrameFenced = /const applyFrame =[\s\S]*?genSnapshot: number,[\s\S]*?genRef: MutableRefObject<number>,[\s\S]*?shouldApplyPollResponse\(genSnapshot, genRef\.current\)[\s\S]*?channelRef\.current = mySeq;/.test(src);
  assert.ok(applyFrameFenced, "applyFrame 은 채널별 genRef/genSnapshot 으로 fence");
  // 각 채널은 자기 generation 만 올린다: relay 는 relayGenerationRef, live 는 liveGenerationRef, detail 는 detailGenerationRef.
  assert.ok(/liveGenerationRef\.current \+= 1;/.test(src), "live RT 는 live generation 만 올릴 것");
  assert.ok(/detailGenerationRef\.current \+= 1;/.test(src), "detail RT 는 detail generation 만 올릴 것");
  // 마스킹 방지: live/detail RT 바로 앞에서 공용 relayGenerationRef 를 올리면 안 된다.
  assert.ok(!/onLiveFrameRef\.current\?\.\([\s\S]{0,80}relayGenerationRef\.current \+= 1;/.test(src),
    "live RT 가 공용 relayGenerationRef 를 올려 relay watchdog poll 을 마스킹하면 안 된다");
  assert.ok(/onLiveFrameRef/.test(src) && /onDetailFrameRef/.test(src), "P0-1 callback ref");
  // P0-1: 구독 effect deps 에 options 가 없어야 한다 (프레임 N개에도 구독 1회)
  const subEffect = src.match(/useEffect\(\(\) => \{\s*if \(!gameId \|\| !isLive\) return;[\s\S]*?\}, \[([^\]]*)\]\);/);
  assert.ok(subEffect, "구독 effect 발견");
  assert.ok(!/options/.test(subEffect![1]), `구독 effect deps 에 options 없어야 함 (deps=${subEffect![1]})`);
});

test("§3 실 Realtime E2E 스크립트가 존재하고 RLS/2-client 계약을 명시한다", () => {
  const e2e = readFileSync(join(worktreeRoot, "scripts/qa/relay-realtime-e2e.mts"), "utf-8");
  assert.ok(/anon/.test(e2e), "anon read/write deny 검증");
  assert.ok(/postgres_changes|\.channel\(/.test(e2e), "2-client 실 Realtime 검증");
  assert.ok(/game_relay_frames/.test(e2e));
});
