// supabase/admin 싱글톤이 트랜지티브 로드 시점에 env 를 요구 — 다른 임포트보다 먼저.
import "./_smoke-env";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  channelsForTick,
  deserializeState,
  frameHash,
  HEARTBEAT_INTERVAL_MS,
  internalGetRequest,
  MAX_PAYLOAD_BYTES,
  newGameState,
  publishGameTick,
  RELAY_FRAME_FULL_EVERY,
  serializeState,
  type FrameRow,
  type PersistedGameState,
  type TickDeps,
} from "../../src/lib/game/relay-live-publisher";
import {
  parseFrameRow,
  REALTIME_POLL_SUPPRESS_MS,
  shouldApplyFrame,
  shouldApplyPollResponse,
  shouldSuppressPoll,
} from "../../src/lib/game/relay-frames-client";

/**
 * qa:relay-realtime — 크관 relay Realtime 이관(B안) 계약 게이트.
 * 삼순 NO-GO(P0-1 구독 churn·P0-2 절감계약·P0-3 race·P1 단일writer) 반영 v2.
 *
 * 축:
 *  §1 수집기 — cadence·변경감지·full/delta·크기가드·재시도·seq회수·heartbeat·cron경계 지속
 *  §2 클라이언트 — fail-close 파싱·heartbeat 억제(무변경 2분)·단조 apply·generation fence
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
  now?: () => number;
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
    now: overrides.now,
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

test("§1 첫 발행은 relay-full, 무변경 tick 은 relay INSERT 0", async () => {
  let clock = 1_000_000;
  const deps = depsWith({ now: () => clock });
  const state = newGameState();
  const first = await publishGameTick(deps, state, "20260825LGHH0", 1);
  assert.equal(first.inserted, 1);
  assert.equal(deps.rows[0].kind, "relay-full");

  clock += 1_000; // heartbeat 간격 미만
  const second = await publishGameTick(deps, state, "20260825LGHH0", 2);
  assert.equal(second.inserted, 0);
  assert.equal(second.skippedUnchanged, 1);
  assert.equal(second.heartbeats, 0);
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
  // now 를 heartbeat 간격 미만으로 고정해 relay 실패만 격리 검증(heartbeat 재시도 노이즈 제거).
  const failDeps = depsWith({ insertResult: false, now: () => 5_000 });
  const state = newGameState();
  const first = await publishGameTick(failDeps, state, "g1", 1);
  assert.equal(first.inserted, 0);
  assert.equal(first.errors.length, 1);
  assert.equal(state.seq, 0, "실패한 seq 는 회수돼야 한다");
  assert.equal(Object.keys(state.lastHash).length, 0, "실패면 hash 미갱신");

  const okDeps = depsWith({ now: () => 5_000 });
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

// P0-2 반영: heartbeat
test("§1 heartbeat — 무변경이 HEARTBEAT_INTERVAL 넘으면 경량 프레임 1건 발행", async () => {
  let clock = 1_000_000;
  const deps = depsWith({ now: () => clock });
  const state = newGameState();
  await publishGameTick(deps, state, "g1", 1); // relay-only tick, full 발행, lastFrameAt=clock

  // 아직 간격 미만 → heartbeat 없음 (tick 2 = relay-only, 무변경)
  clock += HEARTBEAT_INTERVAL_MS - 1;
  let r = await publishGameTick(deps, state, "g1", 2);
  assert.equal(r.heartbeats, 0);

  // 간격 경과 → heartbeat 1건 (tick 4 = relay-only, 무변경; tick 3 은 live 채널이 껴 제외)
  clock += 2;
  r = await publishGameTick(deps, state, "g1", 4);
  assert.equal(r.heartbeats, 1);
  const hb = deps.rows.find((x) => x.kind === "heartbeat");
  assert.ok(hb, "heartbeat 프레임 존재");
  assert.equal((hb!.payload.data as { heartbeat?: boolean }).heartbeat, true);
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
  const s = deserializeState(serializeState({ lastHash: { relay: "h" }, relayChanges: 3, seq: 9, publishedFull: true, lastFrameAtMs: 5 }));
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

test("§2 parseFrameRow — heartbeat 는 data 없이 통과(신선도 신호)", () => {
  const hb = { id: 11, game_id: "g1", seq: 4, kind: "heartbeat", payload: { channel: "relay", ok: true, status: 204, data: { heartbeat: true } } };
  assert.ok(parseFrameRow(hb, "g1"));
  // data 키 자체가 없어도 heartbeat 는 통과
  const hbNoData = { id: 12, game_id: "g1", seq: 5, kind: "heartbeat", payload: { channel: "relay", ok: true, status: 204 } };
  assert.ok(parseFrameRow(hbNoData, "g1"));
});

test("§2 parseFrameRow fail-close — 결측·불일치·미지 kind·빈 payload·비-heartbeat data결측 null", () => {
  assert.equal(parseFrameRow(null, "g1"), null);
  assert.equal(parseFrameRow({ ...VALID_ROW, game_id: "g2" }, "g1"), null);
  assert.equal(parseFrameRow({ ...VALID_ROW, kind: "unknown" }, "g1"), null);
  assert.equal(parseFrameRow({ ...VALID_ROW, payload: null }, "g1"), null);
  assert.equal(parseFrameRow({ ...VALID_ROW, payload: { channel: "relay", ok: false, status: 503, data: {} } }, "g1"), null);
  assert.equal(parseFrameRow({ ...VALID_ROW, payload: { channel: "relay", ok: true, status: 200 } }, "g1"), null, "relay 는 data 결측 차단");
});

// P0-2 반영: 무변경 2분 억제
test("§2 무변경 2분에도 heartbeat 신선도로 poll=0 (P0-2 절감계약)", () => {
  const start = 5_000_000;
  // 수집기 heartbeat 가 HEARTBEAT_INTERVAL 마다 도착하는 2분 구간 시뮬
  let lastFrameAt = start;
  let pollCount = 0;
  for (let t = start; t <= start + 120_000; t += 1_000) {
    // heartbeat 수신: 무변경이어도 10초마다 프레임 도착 → lastFrameAt 갱신
    if ((t - start) % HEARTBEAT_INTERVAL_MS === 0) lastFrameAt = t;
    const suppress = shouldSuppressPoll({ lastRealtimeFrameAtMs: lastFrameAt, nowMs: t, hasInnings: true });
    if (!suppress) pollCount += 1;
  }
  assert.equal(pollCount, 0, "heartbeat 가 살아있는 동안 무변경 2분에도 poll 은 0 이어야 한다");
});

test("§2 수집기 두절 시 폴링 자동 재개 (신선도 협상 폴백)", () => {
  const start = 6_000_000;
  const lastFrameAt = start; // 이후 heartbeat 두절
  let resumedAt: number | null = null;
  for (let t = start; t <= start + 60_000; t += 1_000) {
    const suppress = shouldSuppressPoll({ lastRealtimeFrameAtMs: lastFrameAt, nowMs: t, hasInnings: true });
    if (!suppress && resumedAt === null) resumedAt = t - start;
  }
  assert.ok(resumedAt !== null && resumedAt >= REALTIME_POLL_SUPPRESS_MS && resumedAt <= REALTIME_POLL_SUPPRESS_MS + 1_000,
    `두절 후 임계(${REALTIME_POLL_SUPPRESS_MS}ms) 경과에 폴링 재개 (resumed=${resumedAt})`);
});

test("§2 첫 로드(보유 이닝 0)는 신선해도 항상 폴링", () => {
  const now = 1_000_000;
  assert.equal(shouldSuppressPoll({ lastRealtimeFrameAtMs: now - 1_000, nowMs: now, hasInnings: false }), false);
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

test("§3 migration — 테이블·RLS·publication·heartbeat kind·write정책 부재", () => {
  const sql = readFileSync(join(worktreeRoot, "supabase/migrations/20260825020000_game_relay_frames.sql"), "utf-8")
    .replace(/^\s*--.*$/gm, "");
  assert.ok(/create table public\.game_relay_frames/.test(sql));
  assert.ok(/enable row level security/.test(sql));
  assert.ok(/alter publication supabase_realtime add table public\.game_relay_frames/.test(sql));
  assert.ok(/heartbeat/.test(sql), "heartbeat kind 허용");
  assert.ok(!/create policy[\s\S]*for (insert|update|delete)/i.test(sql), "write 정책 없음 = service_role 전용");
});

test("§3 useGameRelay — 구독·억제·단조·generation·callback ref 배선(P0-1/2/3)", () => {
  const src = readSrc("src/lib/hooks/useGameRelay.ts");
  assert.ok(/postgres_changes/.test(src) && /game_relay_frames/.test(src));
  assert.ok(/shouldSuppressPoll/.test(src), "폴링 억제");
  assert.ok(/parseFrameRow/.test(src), "fail-close 파싱");
  assert.ok(/shouldApplyFrame/.test(src), "단조 가드");
  assert.ok(/shouldApplyPollResponse/.test(src) && /relayGenerationRef/.test(src), "P0-3 generation fence");
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
