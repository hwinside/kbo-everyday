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
  assert.equal(state.seq, 0, "실패한 seq 는 회수돼야 한다");
  assert.equal(Object.keys(state.lastHash).length, 0, "실패면 hash 미갱신");

  const okDeps = depsWith({});
  const second = await publishGameTick(okDeps, state, "g1", 2);
  assert.equal(second.inserted, 1, "실패 프레임은 다음 tick 재발행");
  assert.equal(state.seq, 1);
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

// 삼순 3차 P0 비용: content-only 추정을 손익분기(추가 2,600만/월) 절대 임계로 판정.
// (기존 idle<est 상대비교는 착시 — 절대 임계+기존 chat 합산으로 대체)
const REALTIME_BREAK_EVEN_MONTHLY = 26_000_000;
const EXISTING_CHAT_MONTHLY = 3_000_000; // 7/31 실측 기반 보수 추정(chat Realtime)
test("§1 비용 게이트 — content-only 추정+chat 합산이 손익분기 미만이어야 GREEN", () => {
  // shadow 입력(다음 라이브 1경기 실측으로 대입). 현재는 보수 가정.
  const SHADOW = { framesPerMinutePerGame: 8, avgConcurrentViewers: 100, liveMinutesPerDayPerGame: 180, gamesPerDay: 5 };
  const est = estimateMonthlyRealtimeMessages(SHADOW);
  assert.equal(est, SHADOW.framesPerMinutePerGame * SHADOW.avgConcurrentViewers * SHADOW.liveMinutesPerDayPerGame * SHADOW.gamesPerDay * 30);
  assert.ok(est + EXISTING_CHAT_MONTHLY < REALTIME_BREAK_EVEN_MONTHLY,
    `content-only 추정(${est})+chat(${EXISTING_CHAT_MONTHLY})가 손익분기(${REALTIME_BREAK_EVEN_MONTHLY}) 미만이어야 GREEN`);
});
test("§1 비용 게이트 검출력 — heartbeat 부하 시나리오(34/분)는 손익분기 초과로 RED", () => {
  // 결함주입: heartbeat 시절 프레임률이면 손익분기를 넘겨 RED 여야 게이트가 유효하다.
  const withHeartbeat = estimateMonthlyRealtimeMessages({ framesPerMinutePerGame: 34, avgConcurrentViewers: 100, liveMinutesPerDayPerGame: 180, gamesPerDay: 5 });
  assert.ok(withHeartbeat + EXISTING_CHAT_MONTHLY >= REALTIME_BREAK_EVEN_MONTHLY,
    `heartbeat 부하(${withHeartbeat})는 손익분기 초과여야 검출력 있음`);
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
  assert.ok(/if \(lockLost\) return false;/.test(src), "락 상실 시 INSERT 차단(old writer)");
  assert.ok(/const stillOwner = !lockLost && \(await renewLock\(token\)\);/.test(src), "저장 직전 소유권 재확인");
  assert.ok(/if \(stillOwner\)[\s\S]*SET", stateKey/.test(src), "소유일 때만 state 저장");
  assert.ok(/Promise\.race<TickResult>/.test(src), "tick handler timeout");
  assert.ok(/redis\.call\('del'/.test(src), "compare-delete 해제");
});

test("§3 useGameRelay — 구독·억제·단조·generation·callback ref 배선(P0-1/2/3)", () => {
  const src = readSrc("src/lib/hooks/useGameRelay.ts");
  assert.ok(/postgres_changes/.test(src) && /game_relay_frames/.test(src));
  assert.ok(/shouldSuppressPoll/.test(src), "폴링 억제");
  assert.ok(/parseFrameRow/.test(src), "fail-close 파싱");
  assert.ok(/shouldApplyFrame/.test(src), "단조 가드");
  assert.ok(/shouldApplyPollResponse/.test(src) && /relayGenerationRef/.test(src), "P0-3 generation fence");
  // P0-3 잔존(삼순 2차): live/detail applyFrame 에도 generation fence 적용 + RT live/detail 도 generation++
  const applyFrameFenced = /const applyFrame =[\s\S]*?shouldApplyPollResponse\(myGeneration, relayGenerationRef\.current\)[\s\S]*?channelRef\.current = mySeq;/.test(src);
  assert.ok(applyFrameFenced, "live/detail applyFrame 에 generation fence");
  const rtLiveDetailBumps = (src.match(/relayGenerationRef\.current \+= 1;/g) || []).length;
  assert.ok(rtLiveDetailBumps >= 3, `RT relay+live+detail 이 generation 을 올려야 함 (bumps=${rtLiveDetailBumps})`);
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
