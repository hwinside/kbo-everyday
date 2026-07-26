// 2026-07-26 인시던트(cron 공백 → 5경기 시작알림 전원 미발송) 수정 S1 회귀.
//
// (R1) "1회초 첫 타석 끝나기 전" payload 창 판정 + 시작알림 상태 머신(idle→sending→sent /
// idle→suppressed / lease 회수)을 실제 notifyGameStatusTransitions() 실행으로 검증한다.
// 상태 저장은 마이그레이션 RPC(claim_start_lease/mark_start_sent/release_start_lease/
// suppress_start)의 DB now() 기준 CAS 의미를 그대로 반영하는 인메모리 store로 주입한다.
//
// game-status.ts는 import 시 supabase admin 싱글톤을 생성하므로 더미 env를 먼저 세팅하고
// dynamic import한다(실제 네트워크는 startDeps 주입으로 전혀 타지 않는다).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

import assert from "node:assert/strict";
import { test } from "node:test";
import type { KboRawGame } from "../../src/types/api";
import type { StartNotifyDeps, StartStateRow } from "../../src/lib/notifications/game-status";
import { isWithinFirstAtBatWindow } from "../../src/lib/notifications/start-freshness-policy";
import { deliverTokenChunks } from "../../src/lib/notifications/fcm-batch";

const loadNotify = () =>
  import("../../src/lib/notifications/game-status").then((m) => m.notifyGameStatusTransitions);

const OBSERVED_AT = 1_784_800_000_000;
const BASE: KboRawGame = {
  G_ID: "20260726HHLG0", G_DT: "20260726", G_TM: "18:00", S_NM: "잠실",
  AWAY_ID: "", HOME_ID: "", AWAY_NM: "한화", HOME_NM: "LG",
  T_SCORE_CN: "0", B_SCORE_CN: "0",
  GAME_INN_NO: 1, GAME_TB_SC: "T", GAME_STATE_SC: "2", CANCEL_SC_ID: "0",
  T_PIT_P_NM: "", B_PIT_P_NM: "", W_PIT_P_NM: "", L_PIT_P_NM: "", SV_PIT_P_NM: "",
  STRIKE_CN: 0, BALL_CN: 0, OUT_CN: 0,
  B1_BAT_ORDER_NO: 0, B2_BAT_ORDER_NO: 0, B3_BAT_ORDER_NO: 0,
  B_P_NM: "", T_P_NM: "", T_RANK_NO: 0, B_RANK_NO: 0,
};
const live = (over: Partial<KboRawGame>): KboRawGame => ({ ...BASE, ...over });
const gid = BASE.G_ID;
const gameIdFromUrl = (url: string | undefined): string => (url ?? "").replace("/games/", "");

// game_notify_state 시작 컬럼의 인메모리 모델 — 마이그레이션 RPC의 DB now() CAS 의미 반영.
// nowMs()는 "현재 tick 관측시각"(≈ DB now())을 돌려준다(테스트가 tick마다 세팅).
type Row = {
  start_state: "idle" | "sending" | "sent" | "suppressed";
  start_sent_at: number | null;
  start_lease_until: number | null;
  start_lease_owner: string | null;
  start_notified: boolean;
  start_suppressed_reason: string | null;
};
function makeStore(seed?: Record<string, Partial<Row>>) {
  const rows = new Map<string, Row>();
  const seedRow = (id: string, p: Partial<Row>) =>
    rows.set(id, {
      start_state: "idle", start_sent_at: null, start_lease_until: null,
      start_lease_owner: null, start_notified: false, start_suppressed_reason: null, ...p,
    });
  for (const [id, p] of Object.entries(seed ?? {})) seedRow(id, p);
  let now = OBSERVED_AT;
  const ensure = (id: string) => { if (!rows.has(id)) seedRow(id, {}); return rows.get(id)!; };
  const sent: string[] = [];
  const deps: StartNotifyDeps = {
    storeScheduledSeen: async () => {},
    readStartState: async (id): Promise<StartStateRow | null> => {
      const r = rows.get(id);
      if (!r) return null;
      return {
        start_state: r.start_state,
        start_sent_at: r.start_sent_at != null ? new Date(r.start_sent_at).toISOString() : null,
        start_lease_until: r.start_lease_until != null ? new Date(r.start_lease_until).toISOString() : null,
        start_lease_owner: r.start_lease_owner,
      };
    },
    claimStartLease: async (id, owner) => {
      const r = ensure(id);
      const expired = r.start_state === "sending" && r.start_lease_until != null && r.start_lease_until < now;
      if (r.start_state === "idle" || expired) {
        const { START_LEASE_SECONDS } = await import("../../src/lib/notifications/game-status");
        r.start_state = "sending";
        r.start_lease_until = now + START_LEASE_SECONDS * 1_000;
        r.start_lease_owner = owner;
        return r.start_lease_until;
      }
      return null;
    },
    markStartSent: async (id, owner) => {
      const r = ensure(id);
      if (r.start_state === "sending" && r.start_lease_owner === owner) {
        r.start_state = "sent"; r.start_sent_at = now; r.start_notified = true;
        r.start_lease_until = null; r.start_lease_owner = null;
      }
    },
    releaseStartLease: async (id, owner) => {
      const r = ensure(id);
      if (r.start_state === "sending" && r.start_lease_owner === owner) {
        r.start_state = "idle"; r.start_lease_until = null; r.start_lease_owner = null;
      }
    },
    suppressStart: async (id, reason) => {
      const r = ensure(id);
      const expired = r.start_state === "sending" && r.start_lease_until != null && r.start_lease_until < now;
      if (r.start_state === "idle" || expired) {
        r.start_state = "suppressed"; r.start_suppressed_reason = reason;
        r.start_notified = true; r.start_lease_until = null; r.start_lease_owner = null;
      }
    },
    fansOf: async () => ({ ids: ["u1"], ok: true }),
    sendStart: async (ids, payload) => { sent.push(gameIdFromUrl(payload.url)); return { ok: true, sent: ids.length }; },
  };
  const tick = async (games: KboRawGame[], observedAtMs: number) => {
    now = observedAtMs;
    const notify = await loadNotify();
    return notify(games, { observedAtMs, startDeps: deps });
  };
  return { deps, rows, sent, tick, setNow: (ms: number) => { now = ms; } };
}

// ── (R1) 순수 첫타석창 판정 ────────────────────────────────────────────────
test("첫타석창: 1회초·0아웃·0:0·무주자 = 창 안(true)", () => {
  assert.equal(isWithinFirstAtBatWindow({ inningNo: 1, isTop: true, outs: 0, awayScore: 0, homeScore: 0, runnerOnBase: false }), true);
});
test("첫타석창: 1아웃/득점/주자/1회말/2회 = 창 밖(false)", () => {
  const ok = { inningNo: 1, isTop: true, outs: 0, awayScore: 0, homeScore: 0, runnerOnBase: false };
  assert.equal(isWithinFirstAtBatWindow({ ...ok, outs: 1 }), false, "1아웃");
  assert.equal(isWithinFirstAtBatWindow({ ...ok, awayScore: 1 }), false, "1:0");
  assert.equal(isWithinFirstAtBatWindow({ ...ok, runnerOnBase: true }), false, "주자");
  assert.equal(isWithinFirstAtBatWindow({ ...ok, isTop: false }), false, "1회말");
  assert.equal(isWithinFirstAtBatWindow({ ...ok, inningNo: 2 }), false, "2회");
});
test("첫타석창: 이닝 미보고(null)+무흔적 = 개시 직후로 창 안(true)", () => {
  assert.equal(isWithinFirstAtBatWindow({ inningNo: null, isTop: null, outs: 0, awayScore: 0, homeScore: 0, runnerOnBase: false }), true);
});

// ── 상태 머신 전이 (notifyGameStatusTransitions 실행) ──────────────────────
test("첫 타석 중 = 발송(idle→sending→sent, start_notified read-compat)", async () => {
  const s = makeStore();
  const res = await s.tick([live({})], OBSERVED_AT);
  assert.ok(s.sent.includes(gid), "시작알림 발송");
  assert.equal(res.started, 1);
  const r = s.rows.get(gid)!;
  assert.equal(r.start_state, "sent");
  assert.ok(r.start_sent_at != null, "start_sent_at 세팅");
  assert.equal(r.start_notified, true, "read-compat 위해 start_notified=true");
});

for (const [label, over] of [
  ["2번타자(1아웃 흔적)", { OUT_CN: 1 }],
  ["1아웃", { OUT_CN: 1 }],
  ["1:0 득점", { T_SCORE_CN: "1" }],
  ["루상 주자", { B1_BAT_ORDER_NO: 1 }],
  ["이닝 교체(1회말)", { GAME_TB_SC: "B" }],
  ["이닝 교체(2회초)", { GAME_INN_NO: 2 }],
] as Array<[string, Partial<KboRawGame>]>) {
  test(`창 밖(${label}) = suppressed(past_first_at_bat), 미발송`, async () => {
    const s = makeStore();
    await s.tick([live(over)], OBSERVED_AT);
    assert.ok(!s.sent.includes(gid), "발송되면 안 됨");
    const r = s.rows.get(gid)!;
    assert.equal(r.start_state, "suppressed");
    assert.equal(r.start_suppressed_reason, "past_first_at_bat");
    assert.equal(r.start_notified, true, "read-compat(종료알림·LA wake) 위해 true");
  });
}

test("lease 유효 중 = 중복 발송 skip(다른 invocation 소유)", async () => {
  const s = makeStore({ [gid]: { start_state: "sending", start_lease_until: OBSERVED_AT + 30_000, start_lease_owner: "other" } });
  await s.tick([live({})], OBSERVED_AT);
  assert.ok(!s.sent.includes(gid), "유효 lease면 발송 skip");
  assert.equal(s.rows.get(gid)!.start_state, "sending", "상태 유지");
  assert.equal(s.rows.get(gid)!.start_lease_owner, "other", "남의 lease 안 뺏음");
});

test("겹친 invocation: A가 45s 넘게 발송 중이어도 T+60 B는 재선점하지 않아 exact-once", async () => {
  const s = makeStore();
  let startSends = 0;
  let unblockA!: () => void;
  let aStarted!: () => void;
  const aSending = new Promise<void>((resolve) => { aStarted = resolve; });
  const aBlocked = new Promise<void>((resolve) => { unblockA = resolve; });
  s.deps.sendStart = async (ids, payload) => {
    if (!payload.dataOnly) {
      startSends += 1;
      if (startSends === 1) {
        aStarted();
        await aBlocked;
      }
    }
    return { ok: true, sent: ids.length };
  };

  const invocationA = s.tick([live({})], OBSERVED_AT);
  await aSending;
  await s.tick([live({})], OBSERVED_AT + 60_000);
  assert.equal(startSends, 1, "T+60 B는 A의 120s lease를 재선점하지 않음");
  unblockA();
  await invocationA;
  assert.equal(startSends, 1, "사용자 시작알림 exact-once");
  assert.equal(s.rows.get(gid)!.start_state, "sent");
});

test("발송 deadline에서 chunk를 중단하고 lease 만료 전 sending 유지", async () => {
  const s = makeStore();
  s.deps.fansOf = async () => ({
    ids: Array.from({ length: 1_000 }, (_, i) => `u${i}`),
    ok: true,
  });
  let attempted = 0;
  let wiredDeadline: number | undefined;
  s.deps.sendStart = async (ids, payload, _pref, _platform, opts) => {
    if (payload.dataOnly) return { ok: true, sent: ids.length };
    wiredDeadline = opts?.deadlineAtMs;
    assert.ok(wiredDeadline != null, "lease 기반 deadlineAtMs 배선");
    let clock = wiredDeadline - 1;
    const delivery = await deliverTokenChunks(ids, async (chunk) => {
      attempted += chunk.length;
      clock += 2;
      return { successCount: chunk.length, failureCount: 0, responses: chunk.map(() => ({})) };
    }, 500, { deadlineAtMs: wiredDeadline, now: () => clock });
    return { ...delivery, cleaned: 0, skipped: 0 };
  };

  const res = await s.tick([live({})], OBSERVED_AT);
  const { START_LEASE_SECONDS, START_SEND_DEADLINE_MARGIN_MS } =
    await import("../../src/lib/notifications/game-status");
  assert.equal(
    wiredDeadline,
    OBSERVED_AT + START_LEASE_SECONDS * 1_000 - START_SEND_DEADLINE_MARGIN_MS,
    "deadline = DB lease_until - 안전마진",
  );
  assert.equal(attempted, 500, "deadline 뒤 두 번째 chunk는 시작하지 않음");
  assert.equal(res.started, 0, "partial은 sent로 집계하지 않음");
  assert.equal(s.rows.get(gid)!.start_state, "sending", "deadline partial은 lease를 release하지 않음");
});

test("크래시/partial sending은 유효 lease 동안 skip하고 만료 후 tick에서 재-claim", async () => {
  const s = makeStore();
  let attempts = 0;
  s.deps.sendStart = async (ids, payload) => {
    if (payload.dataOnly) return { ok: true, sent: ids.length };
    attempts += 1;
    if (attempts === 1) {
      return {
        ok: false, sent: 0, tokens: 0, failed: ids.length, cleaned: 0, skipped: 0,
        lastError: "deadline_exceeded",
      };
    }
    s.sent.push(gameIdFromUrl(payload.url));
    return { ok: true, sent: ids.length };
  };
  const { START_LEASE_SECONDS } = await import("../../src/lib/notifications/game-status");

  await s.tick([live({})], OBSERVED_AT);
  assert.equal(s.rows.get(gid)!.start_state, "sending", "절단 뒤 sending 잔존");
  await s.tick([live({})], OBSERVED_AT + 60_000);
  assert.equal(attempts, 1, "유효 lease 중 다음 cron은 재선점 안 함");
  await s.tick([live({})], OBSERVED_AT + START_LEASE_SECONDS * 1_000 + 1);
  assert.equal(attempts, 2, "lease 만료 후 tick에서 재선점");
  assert.equal(s.rows.get(gid)!.start_state, "sent");
});

test("lease 만료 sending = 회수 후 발송(sent)", async () => {
  const s = makeStore({ [gid]: { start_state: "sending", start_lease_until: OBSERVED_AT - 1_000, start_lease_owner: "old" } });
  await s.tick([live({})], OBSERVED_AT);
  assert.ok(s.sent.includes(gid), "만료 lease 회수 → 발송");
  const r = s.rows.get(gid)!;
  assert.equal(r.start_state, "sent");
  assert.notEqual(r.start_lease_owner, "old");
});

test("창 닫힘 강제전이: idle→suppressed / 만료 sending→suppressed / 유효 sending은 보존", async () => {
  // idle + 창밖 → suppressed
  const a = makeStore({ [gid]: { start_state: "idle" } });
  await a.tick([live({ OUT_CN: 1 })], OBSERVED_AT);
  assert.equal(a.rows.get(gid)!.start_state, "suppressed", "idle→suppressed");
  // 만료 sending + 창밖 → suppressed
  const b = makeStore({ [gid]: { start_state: "sending", start_lease_until: OBSERVED_AT - 1_000, start_lease_owner: "old" } });
  await b.tick([live({ OUT_CN: 1 })], OBSERVED_AT);
  assert.equal(b.rows.get(gid)!.start_state, "suppressed", "만료 sending→suppressed");
  // 새 120s lease의 T+60 유효 sending + 창밖 → 보존, 만료 뒤 tick에서만 suppressed
  const { START_LEASE_SECONDS } = await import("../../src/lib/notifications/game-status");
  const c = makeStore({ [gid]: {
    start_state: "sending",
    start_lease_until: OBSERVED_AT + START_LEASE_SECONDS * 1_000,
    start_lease_owner: "live",
  } });
  await c.tick([live({ OUT_CN: 1 })], OBSERVED_AT + 60_000);
  assert.equal(c.rows.get(gid)!.start_state, "sending", "T+60 유효 sending은 suppressed로 안 뺏음");
  await c.tick([live({ OUT_CN: 1 })], OBSERVED_AT + START_LEASE_SECONDS * 1_000 + 1);
  assert.equal(c.rows.get(gid)!.start_state, "suppressed", "새 lease 만료 뒤에만 suppressed 회수");
});

test("cron 공백(17:59 예정 → 18:02 첫 관측): 창 열림=발송 / 창 닫힘=suppressed", async () => {
  const late = OBSERVED_AT + 180_000; // 3분 뒤 첫 관측(공백)
  // 창 열림 — 첫 관측이 live지만 아직 첫 타석 안(공백에도 재발송 가능이 인시던트 수정 핵심)
  const open = makeStore(); // 사전 행 없음(scheduled 관측 놓침)
  await open.tick([live({})], late);
  assert.ok(open.sent.includes(gid), "공백 후에도 창 열려 있으면 발송(전원 미발송 재발 차단)");
  assert.equal(open.rows.get(gid)!.start_state, "sent");
  // 창 닫힘 — 공백 사이 첫 타석 종료
  const closed = makeStore();
  await closed.tick([live({ OUT_CN: 1, B1_BAT_ORDER_NO: 2 })], late);
  assert.ok(!closed.sent.includes(gid), "창 닫혔으면 뒷북 발송 금지");
  assert.equal(closed.rows.get(gid)!.start_state, "suppressed");
});

test("self-heal: 발송 인프라 실패 → idle 복귀 → 다음 tick 재시도 발송", async () => {
  const s = makeStore();
  let firstSend = true;
  s.deps.sendStart = async (ids, payload) => {
    if (firstSend) { firstSend = false; return { ok: false, sent: 0, tokens: 0, failed: ids.length, cleaned: 0, skipped: 0 }; }
    s.sent.push(gameIdFromUrl(payload.url));
    return { ok: true, sent: ids.length };
  };
  await s.tick([live({})], OBSERVED_AT); // tick1: 발송 실패 → release → idle
  assert.ok(!s.sent.includes(gid), "tick1 발송 실패");
  assert.equal(s.rows.get(gid)!.start_state, "idle", "실패 시 idle 복귀");
  await s.tick([live({})], OBSERVED_AT + 60_000); // tick2: 창 여전히 열림 → 재시도
  assert.ok(s.sent.includes(gid), "tick2 재발송");
  assert.equal(s.rows.get(gid)!.start_state, "sent");
});

test("terminal 재진입 금지: sent/suppressed는 재평가·재발송 안 함", async () => {
  const s = makeStore({ [gid]: { start_state: "sent", start_notified: true, start_sent_at: OBSERVED_AT - 1000 } });
  await s.tick([live({})], OBSERVED_AT + 60_000);
  assert.ok(!s.sent.includes(gid), "sent면 재발송 없음");
  const s2 = makeStore({ [gid]: { start_state: "suppressed", start_notified: true } });
  await s2.tick([live({})], OBSERVED_AT + 60_000);
  assert.ok(!s2.sent.includes(gid), "suppressed면 재발송 없음");
});
