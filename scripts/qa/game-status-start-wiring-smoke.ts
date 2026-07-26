// 시작알림 "프로덕션 배선" 회귀(실행 검증) — 소스 grep이 아니라 실제
// notifyGameStatusTransitions() 실행으로 기본(미주입) 경로가 올바른 RPC/저장을 타는지 본다.
//
// 2026-07-26 인시던트 수정(S1)으로 발송 게이트가 90초 연속관측 → (R1) "첫 타석 창" 상태
// 머신으로 교체됐다. 따라서 발송/억제 판정 자체의 회귀는 game-status-start-state-machine.ts가
// 담당하고, 이 파일은 (a) 예정 관측 저장이 관측시각 기준 원자 단조 RPC인지, (b) 시작알림
// 기본 경로가 lease CAS RPC(claim_start_lease → mark_start_sent)를 타는지, (c) 마이그레이션
// SQL 계약, (d) channel_born 예산 배선만 고정한다.
//
// game-status.ts는 import 시 supabase admin 싱글톤을 생성하므로 더미 env를 먼저 세팅하고
// dynamic import한다(실제 네트워크는 startDeps 주입/클라이언트 스텁으로 타지 않는다).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import type { KboRawGame } from "../../src/types/api";
import type { StartNotifyDeps } from "../../src/lib/notifications/game-status";

const loadNotify = () =>
  import("../../src/lib/notifications/game-status").then((m) => m.notifyGameStatusTransitions);

const OBSERVED_AT = 1_784_800_000_000;

const BASE: KboRawGame = {
  G_ID: "", G_DT: "20260726", G_TM: "18:00", S_NM: "잠실",
  AWAY_ID: "", HOME_ID: "", AWAY_NM: "", HOME_NM: "",
  T_SCORE_CN: "0", B_SCORE_CN: "0",
  GAME_INN_NO: 1, GAME_TB_SC: "T", GAME_STATE_SC: "2", CANCEL_SC_ID: "0",
  T_PIT_P_NM: "", B_PIT_P_NM: "", W_PIT_P_NM: "", L_PIT_P_NM: "", SV_PIT_P_NM: "",
  STRIKE_CN: 0, BALL_CN: 0, OUT_CN: 0,
  B1_BAT_ORDER_NO: 0, B2_BAT_ORDER_NO: 0, B3_BAT_ORDER_NO: 0,
  B_P_NM: "", T_P_NM: "", T_RANK_NO: 0, B_RANK_NO: 0,
};
const liveGame = (over: Partial<KboRawGame>): KboRawGame => ({ ...BASE, ...over });
const schedGame = (over: Partial<KboRawGame>): KboRawGame => liveGame({ GAME_STATE_SC: "1", ...over });
const gameIdFromUrl = (url: string | undefined): string => (url ?? "").replace("/games/", "");

// supabase-js .from() 체인 스텁 — 어떤 메서드 체인이든 {data,error} 로 await 가능.
function chainStub(result: { data?: unknown; error?: unknown }) {
  const p = Promise.resolve(result);
  const proxy: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return p.then.bind(p);
      if (prop === "catch") return p.catch.bind(p);
      if (prop === "finally") return p.finally.bind(p);
      return () => proxy;
    },
    apply() { return proxy; },
  });
  return proxy;
}

// 앞 경기 처리 지연이 뒤 경기 시작알림 판정을 오염시키지 않는지(게이트가 payload 창 기반이라
// 처리시점 Date.now()에 무관) — 두 in-window live 경기 모두 발송돼야 한다.
test("배선: 두 in-window live 경기 모두 발송(판정은 payload 창, 처리 지연 무관)", async () => {
  const sent: string[] = [];
  const state = new Map<string, "idle" | "sending" | "sent">();
  let clock = OBSERVED_AT;
  const realNow = Date.now;
  Date.now = () => clock;
  const deps: StartNotifyDeps = {
    storeScheduledSeen: async () => {},
    readStartState: async (id) => ({
      start_state: state.get(id) ?? "idle", start_sent_at: null, start_lease_until: null, start_lease_owner: null,
    }),
    claimStartLease: async (id) => { if ((state.get(id) ?? "idle") !== "idle") return false; state.set(id, "sending"); return true; },
    markStartSent: async (id) => { state.set(id, "sent"); },
    releaseStartLease: async (id) => { state.set(id, "idle"); },
    suppressStart: async () => {},
    fansOf: async () => ({ ids: ["u1"], ok: true }),
    sendStart: async (ids, payload) => { sent.push(gameIdFromUrl(payload.url)); clock += 26_000; return { ok: true, sent: ids.length }; },
  };
  try {
    const notify = await loadNotify();
    const res = await notify([
      liveGame({ G_ID: "20260726SSKI0", AWAY_NM: "삼성", HOME_NM: "KIA" }),
      liveGame({ G_ID: "20260726HHLG0", AWAY_NM: "한화", HOME_NM: "LG" }),
    ], { observedAtMs: OBSERVED_AT, startDeps: deps });
    assert.ok(sent.includes("20260726SSKI0") && sent.includes("20260726HHLG0"), "두 경기 모두 발송");
    assert.equal(res.started, 2);
  } finally {
    Date.now = realNow;
  }
});

test("배선: 예정 관측 기록은 처리시점이 아니라 관측시각으로 저장", async () => {
  let stored: { ids: string[]; iso: string } | null = null;
  const realNow = Date.now;
  Date.now = () => OBSERVED_AT + 999_000; // 처리시점이 관측보다 999초 뒤였다고 가정
  const deps: StartNotifyDeps = {
    storeScheduledSeen: async (ids, iso) => { stored = { ids, iso }; },
    readStartState: async () => null,
    claimStartLease: async () => true,
    markStartSent: async () => {},
    releaseStartLease: async () => {},
    suppressStart: async () => {},
    fansOf: async () => ({ ids: [], ok: true }),
    sendStart: async () => ({ ok: true, sent: 0 }),
  };
  try {
    const notify = await loadNotify();
    await notify([schedGame({ G_ID: "20260726HTNC0", AWAY_NM: "KT", HOME_NM: "NC" })],
      { observedAtMs: OBSERVED_AT, startDeps: deps });
    assert.ok(stored, "예정 경기 관측이 기록돼야 한다");
    assert.equal(stored!.iso, new Date(OBSERVED_AT).toISOString(), "관측시각으로 저장(처리시점 Date.now() 아님)");
    assert.deepEqual(stored!.ids, ["20260726HTNC0"]);
  } finally {
    Date.now = realNow;
  }
});

test("배선: 프로덕션 기본 예정저장은 mark_scheduled_seen RPC(원자 단조) — naive upsert 아님", async () => {
  const admin = await import("../../src/lib/supabase/admin");
  const client = admin.supabaseAdmin as unknown as {
    rpc: (name: string, args: unknown) => Promise<{ data: unknown; error: null }>;
    from: (...a: unknown[]) => unknown;
  };
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  let fromCalled = false;
  const origRpc = client.rpc;
  const origFrom = client.from;
  client.rpc = (name, args) => { rpcCalls.push({ name, args }); return Promise.resolve({ data: null, error: null }); };
  client.from = (...a: unknown[]) => { fromCalled = true; return origFrom.apply(client, a as []); };
  try {
    const notify = await loadNotify();
    await notify([schedGame({ G_ID: "20260726HTNC0", AWAY_NM: "KT", HOME_NM: "NC" })], {
      observedAtMs: OBSERVED_AT,
      // storeScheduledSeen 미주입 → 프로덕션 defaultStoreScheduledSeen 경로 실행.
      startDeps: {
        readStartState: async () => null,
        claimStartLease: async () => false, // 발송 경로는 이 테스트 관심 밖 — 선점 실패로 조기 종료
        markStartSent: async () => {},
        releaseStartLease: async () => {},
        suppressStart: async () => {},
        fansOf: async () => ({ ids: [], ok: true }),
        sendStart: async () => ({ ok: true, sent: 0 }),
      },
    });
    const call = rpcCalls.find((c) => c.name === "mark_scheduled_seen");
    assert.ok(call, "기본 예정저장은 mark_scheduled_seen RPC 호출");
    assert.deepEqual((call!.args as { p_game_ids: string[] }).p_game_ids, ["20260726HTNC0"]);
    assert.equal((call!.args as { p_observed_at: string }).p_observed_at, new Date(OBSERVED_AT).toISOString());
    assert.equal(fromCalled, false, "예정저장은 naive .from().upsert() 경로가 아니라 원자 RPC만");
  } finally {
    client.rpc = origRpc;
    client.from = origFrom;
  }
});

test("배선: 시작알림 기본 경로는 lease CAS RPC(claim_start_lease → mark_start_sent) 호출", async () => {
  const admin = await import("../../src/lib/supabase/admin");
  const client = admin.supabaseAdmin as unknown as {
    rpc: (name: string, args: unknown) => Promise<{ data: unknown; error: null }>;
    from: (...a: unknown[]) => unknown;
  };
  const rpcCalls: string[] = [];
  const origRpc = client.rpc;
  const origFrom = client.from;
  client.rpc = (name) => {
    rpcCalls.push(name);
    if (name === "claim_start_lease") return Promise.resolve({ data: true, error: null });
    return Promise.resolve({ data: null, error: null });
  };
  client.from = () => chainStub({ data: null, error: null }); // readStartState/ensure → 네트워크 차단
  try {
    const notify = await loadNotify();
    const res = await notify([liveGame({ G_ID: "20260726HHLG0", AWAY_NM: "한화", HOME_NM: "LG" })], {
      observedAtMs: OBSERVED_AT,
      // claimStartLease/markStartSent 미주입 → 프로덕션 default(RPC) 경로 실행. 발송/팬만 주입.
      startDeps: {
        fansOf: async () => ({ ids: ["u1"], ok: true }),
        sendStart: async () => ({ ok: true, sent: 1 }),
      },
    });
    assert.ok(rpcCalls.includes("claim_start_lease"), "claim_start_lease RPC 호출");
    assert.ok(rpcCalls.includes("mark_start_sent"), "발송 성공 후 mark_start_sent RPC 호출");
    assert.ok(rpcCalls.indexOf("claim_start_lease") < rpcCalls.indexOf("mark_start_sent"), "claim → mark 순서");
    assert.equal(res.started, 1);
  } finally {
    client.rpc = origRpc;
    client.from = origFrom;
  }
});

// ── 마이그레이션 SQL 계약 ──────────────────────────────────────────────────
test("마이그레이션 계약: mark_scheduled_seen RPC는 ON CONFLICT + GREATEST 원자 단조 저장", () => {
  const sql = readFileSync("supabase/migrations/20260724_notify_scheduled_seen_monotonic.sql", "utf8").toLowerCase();
  assert.match(sql, /create or replace function\s+mark_scheduled_seen/);
  assert.match(sql, /on conflict\s*\(game_id\)\s*do update/);
  assert.match(sql, /greatest\(\s*game_notify_state\.last_seen_scheduled_at\s*,\s*excluded\.last_seen_scheduled_at\s*\)/);
});

test("마이그레이션 계약: 상태 머신 컬럼·CAS RPC·백필이 멱등적으로 정의됨", () => {
  const sql = readFileSync("supabase/migrations/20260726_start_notify_state_machine.sql", "utf8").toLowerCase();
  // 신규 컬럼(멱등)
  for (const col of ["start_state", "start_sent_at", "start_lease_until", "start_lease_owner", "start_suppressed_reason", "start_fanout_cursor"]) {
    assert.match(sql, new RegExp(`add column if not exists ${col}`), `${col} IF NOT EXISTS`);
  }
  assert.match(sql, /start_state text not null default 'idle'/);
  assert.match(sql, /check \(start_state in \('idle', 'sending', 'sent', 'suppressed'\)\)/);
  // 백필: start_notified=true → sent
  assert.match(sql, /set start_state = 'sent'[\s\S]*where start_notified = true and start_state <> 'sent'/);
  // CAS RPC 4종
  for (const fn of ["claim_start_lease", "mark_start_sent", "release_start_lease", "suppress_start"]) {
    assert.match(sql, new RegExp(`create or replace function\\s+${fn}`), `${fn} 정의`);
    assert.match(sql, new RegExp(`grant execute on function ${fn}`), `${fn} service_role grant`);
  }
  // lease 선점은 idle 또는 만료 sending만
  assert.match(sql, /start_state = 'idle'\s*or \(start_state = 'sending' and start_lease_until < now\(\)\)/);
  // read-compat: sent/suppressed 시 start_notified=true 유지
  assert.match(sql, /start_notified = true/);
});

test("배선: channel_born actual-marking 전역 예산 helper를 전 경기·양 팀이 공유", () => {
  const src = readFileSync("src/lib/notifications/live-activity.ts", "utf8");
  const fnStart = src.indexOf("export async function pushLiveActivityStarts");
  assert.ok(fnStart >= 0, "pushLiveActivityStarts 존재");
  const fnBody = src.slice(fnStart);
  const loopIdx = fnBody.indexOf("for (const g of liveGames)");
  const budgetIdx = fnBody.indexOf("const channelBornMarkBudget = createChannelBornMarkBudget()");
  assert.ok(loopIdx >= 0, "경기 루프 존재");
  assert.ok(budgetIdx >= 0 && budgetIdx < loopIdx, "전역 actual-marking 예산은 경기 루프 전 1회 생성");
  assert.equal(
    fnBody.match(/gameStartMs: startedAt, channelBornMarkBudget/g)?.length,
    2,
    "away/home 양쪽에 같은 전역 예산 전달",
  );
});
