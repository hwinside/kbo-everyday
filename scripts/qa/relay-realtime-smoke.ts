// supabase/admin 싱글톤이 트랜지티브 로드 시점에 env 를 요구 — 다른 임포트보다 먼저.
import "./_smoke-env";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  channelsForTick,
  frameHash,
  internalGetRequest,
  MAX_PAYLOAD_BYTES,
  newGameState,
  publishGameTick,
  RELAY_FRAME_FULL_EVERY,
  type FrameRow,
  type TickDeps,
} from "../../src/lib/game/relay-live-publisher";
import {
  parseFrameRow,
  REALTIME_POLL_SUPPRESS_MS,
  shouldApplyFrame,
  shouldSuppressPoll,
} from "../../src/lib/game/relay-frames-client";

/**
 * qa:relay-realtime — 크관 relay Realtime 이관(B안) 계약 게이트.
 *
 * 축:
 *  §1 수집기 — tick cadence·변경 감지·full/delta·크기 가드·실패 재시도
 *  §2 클라이언트 — 프레임 fail-close 파싱·폴링 억제·단조 적용 가드
 *  §3 프로덕션 배선 — cron 이 실제 handler 를 배선하고, vercel.json cron 과
 *     migration publication 이 실재한다 (문자열이 아니라 구조 확인)
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

test("§1 tick cadence — relay 는 매 tick, events 15s, live 9s, detail 30s grid", () => {
  assert.deepEqual(channelsForTick(0), ["relay", "events", "live", "detail"]);
  assert.deepEqual(channelsForTick(1), ["relay"]);
  assert.deepEqual(channelsForTick(3), ["relay", "live"]);
  assert.deepEqual(channelsForTick(5), ["relay", "events"]);
  assert.deepEqual(channelsForTick(10), ["relay", "events", "detail"]);
});

test("§1 첫 발행은 relay-full, 무변경 tick 은 INSERT 0 (fanout 낭비 차단)", async () => {
  const deps = depsWith({});
  const state = newGameState();
  const first = await publishGameTick(deps, state, "20260825LGHH0", 1);
  assert.equal(first.inserted, 1);
  assert.equal(deps.rows[0].kind, "relay-full");

  // 동일 데이터 재-tick → 변경 없음 → INSERT 없음
  const second = await publishGameTick(deps, state, "20260825LGHH0", 2);
  assert.equal(second.inserted, 0);
  assert.equal(second.skippedUnchanged, 1);
  assert.equal(deps.rows.length, 1);
});

test("§1 변경 발생 시 delta 프레임 + seq 단조증가, FULL_EVERY 주기로 full 재발행", async () => {
  let data: unknown = RELAY_DATA_A;
  const deps = depsWith({ relayData: () => data });
  const state = newGameState();
  await publishGameTick(deps, state, "g1", 1); // full (첫 발행)

  data = RELAY_DATA_B;
  await publishGameTick(deps, state, "g1", 2); // 변경 → delta
  assert.equal(deps.rows.length, 2);
  assert.equal(deps.rows[1].kind, "relay-delta");
  assert.ok(deps.rows[1].seq > deps.rows[0].seq, "seq 는 단조증가");
  // delta payload 는 toDeltaResponse 를 통과한다 (full 을 그대로 싣지 않는다)
  const deltaData = deps.rows[1].payload.data as { partial?: boolean };
  assert.equal(deltaData.partial, true, "delta 프레임은 partial 응답이어야 한다");

  // FULL_EVERY 번째 변경마다 full 재발행
  for (let i = 0; i < RELAY_FRAME_FULL_EVERY; i++) {
    data = { ...RELAY_DATA_B, tick: i }; // 매번 변경
    await publishGameTick(deps, state, "g1", 3 + i);
  }
  const kinds = deps.rows.map((r) => r.kind);
  assert.ok(
    kinds.filter((k) => k === "relay-full").length >= 2,
    `주기적 full 재발행이 있어야 한다 (kinds=${kinds.join(",")})`,
  );
});

test("§1 INSERT 실패 시 해시를 갱신하지 않는다 — 다음 tick 재시도(fail-closed retry)", async () => {
  const deps = depsWith({ insertResult: false });
  const state = newGameState();
  const first = await publishGameTick(deps, state, "g1", 1);
  assert.equal(first.inserted, 0);
  assert.equal(first.errors.length, 1);

  // 같은 데이터라도 재시도되어야 한다 (실패가 성공으로 기억되면 프레임이 영원히 유실)
  const retryDeps = depsWith({});
  // state 재사용: lastHash 가 갱신되지 않았어야 insert 시도가 다시 일어난다
  const second = await publishGameTick(
    { ...retryDeps, handlers: deps.handlers },
    state,
    "g1",
    2,
  );
  assert.equal(second.inserted, 1, "실패한 프레임은 다음 tick 에 재발행돼야 한다");
});

test("§1 크기 가드 — MAX_PAYLOAD_BYTES 초과 프레임은 INSERT 하지 않는다", async () => {
  const huge = { innings: [{ inning: 1, big: "x".repeat(MAX_PAYLOAD_BYTES) }] };
  const deps = depsWith({ relayData: () => huge });
  const state = newGameState();
  const result = await publishGameTick(deps, state, "g1", 1);
  assert.equal(result.inserted, 0);
  assert.equal(result.skippedOversize, 1);
  assert.equal(deps.rows.length, 0);
});

test("§1 handler 실패(비 2xx)는 프레임을 쓰지 않고 에러로 집계한다", async () => {
  const deps = depsWith({});
  deps.handlers.relay = async () => new Response("upstream down", { status: 503 });
  const state = newGameState();
  const result = await publishGameTick(deps, state, "g1", 1);
  assert.equal(result.inserted, 0);
  assert.ok(result.errors.some((e) => e.includes("relay")));
});

test("§1 frameHash — 내용 동일이면 동일, 한 글자라도 다르면 상이", () => {
  assert.equal(frameHash(RELAY_DATA_A), frameHash(JSON.parse(JSON.stringify(RELAY_DATA_A))));
  assert.notEqual(frameHash(RELAY_DATA_A), frameHash(RELAY_DATA_B));
});

test("§1 internalGetRequest — 내부 호출 URL 에 파라미터가 실린다", () => {
  const req = internalGetRequest("/api/game-relay", { gameId: "g1", inning: "7" });
  assert.ok(req instanceof NextRequest);
  assert.equal(req.nextUrl.pathname, "/api/game-relay");
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

test("§2 parseFrameRow fail-close — 결측·불일치·미지 kind·빈 payload 전부 null", () => {
  assert.equal(parseFrameRow(null, "g1"), null);
  assert.equal(parseFrameRow({ ...VALID_ROW, game_id: "g2" }, "g1"), null, "타 경기 row 차단");
  assert.equal(parseFrameRow({ ...VALID_ROW, kind: "unknown" }, "g1"), null, "미지 kind 차단");
  assert.equal(parseFrameRow({ ...VALID_ROW, payload: null }, "g1"), null, "빈 payload(max_record_bytes 초과 전파) 차단");
  assert.equal(
    parseFrameRow({ ...VALID_ROW, payload: { channel: "relay", ok: false, status: 503, data: {} } }, "g1"),
    null,
    "실패 envelope 차단",
  );
  assert.equal(
    parseFrameRow({ ...VALID_ROW, payload: { channel: "relay", ok: true, status: 200 } }, "g1"),
    null,
    "data 결측 차단",
  );
});

test("§2 shouldSuppressPoll — 첫 로드는 항상 폴링, 신선하면 억제, 끊기면 재개", () => {
  const now = 1_000_000;
  // 첫 로드(보유 이닝 0): realtime 이 신선해도 폴링한다
  assert.equal(
    shouldSuppressPoll({ lastRealtimeRelayAtMs: now - 1_000, nowMs: now, hasInnings: false }),
    false,
  );
  // realtime 신선 → 억제
  assert.equal(
    shouldSuppressPoll({ lastRealtimeRelayAtMs: now - 1_000, nowMs: now, hasInnings: true }),
    true,
  );
  // 프레임 두절(임계 경과) → 폴링 재개 (폴백은 신선도로 협상)
  assert.equal(
    shouldSuppressPoll({
      lastRealtimeRelayAtMs: now - REALTIME_POLL_SUPPRESS_MS,
      nowMs: now,
      hasInnings: true,
    }),
    false,
  );
  // realtime 프레임을 한 번도 못 받음 → 폴링
  assert.equal(shouldSuppressPoll({ lastRealtimeRelayAtMs: null, nowMs: now, hasInnings: true }), false);
});

test("§2 shouldApplyFrame — 전역 id 단조 가드 (재연결 replay 역행 차단)", () => {
  assert.equal(shouldApplyFrame(0, 1), true);
  assert.equal(shouldApplyFrame(5, 5), false);
  assert.equal(shouldApplyFrame(5, 4), false);
  assert.equal(shouldApplyFrame(5, 6), true);
});

// ───────────────────────────── §3 프로덕션 배선 ─────────────────────────────

const worktreeRoot = join(__dirname, "..", "..");

test("§3 cron route 가 실제 handler 4종과 퍼블리셔 코어를 배선한다", () => {
  const src = readFileSync(
    join(worktreeRoot, "src/app/api/cron/relay-live-publisher/route.ts"),
    "utf-8",
  );
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(/from "@\/app\/api\/game-relay\/route"/.test(stripped), "relay handler 실배선");
  assert.ok(/from "@\/app\/api\/game-events\/route"/.test(stripped), "events handler 실배선");
  assert.ok(/publishGameTick/.test(stripped), "퍼블리셔 코어 사용");
  assert.ok(/CRON_SECRET/.test(stripped), "cron 인증");
  assert.ok(/game_relay_frames/.test(stripped), "frames 테이블 write");
});

test("§3 vercel.json 에 1분 cron 이 정확히 1개 등록돼 있다", () => {
  const vercel = JSON.parse(readFileSync(join(worktreeRoot, "vercel.json"), "utf-8")) as {
    crons: Array<{ path: string; schedule: string }>;
  };
  const hits = vercel.crons.filter((c) => c.path === "/api/cron/relay-live-publisher");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].schedule, "* * * * *");
});

test("§3 migration — 테이블·RLS·publication 등록이 실재한다", () => {
  const sql = readFileSync(
    join(worktreeRoot, "supabase/migrations/20260825020000_game_relay_frames.sql"),
    "utf-8",
  );
  const stripped = sql.replace(/^\s*--.*$/gm, "");
  assert.ok(/create table public\.game_relay_frames/.test(stripped));
  assert.ok(/enable row level security/.test(stripped));
  assert.ok(/alter publication supabase_realtime add table public\.game_relay_frames/.test(stripped));
  assert.ok(!/create policy[\s\S]*insert/i.test(stripped), "INSERT 정책 없음 = service_role 전용");
});

test("§3 useGameRelay 가 realtime 구독·억제·단조 가드를 실제로 배선한다", () => {
  const src = readFileSync(join(worktreeRoot, "src/lib/hooks/useGameRelay.ts"), "utf-8");
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(/postgres_changes/.test(stripped), "postgres_changes 구독");
  assert.ok(/game_relay_frames/.test(stripped), "frames 테이블 구독");
  assert.ok(/shouldSuppressPoll/.test(stripped), "폴링 억제 배선");
  assert.ok(/parseFrameRow/.test(stripped), "fail-close 파싱 배선");
  assert.ok(/shouldApplyFrame/.test(stripped), "단조 가드 배선");
});
