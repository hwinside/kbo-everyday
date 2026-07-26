// 2026-07-24 LG:한화 시작알림 억제 사고 — 시작알림 게이트 "프로덕션 배선" 회귀(실행 검증).
//
// 삼순 리뷰 기준③: 정책 함수(shouldSendStartNotification) 직접호출만으론 부족하다. 실제
// notifyGameStatusTransitions()를 두 개의 live 경기로 실행하고, 앞 경기 FCM 대량발송이 26초
// 지연돼(처리 시점 Date.now()가 전진) 뒤 경기(LG)가 처리될 때에도, 시작알림이 **관측(fetch)
// 시각** 기준으로 정상 발송되는지 확인한다. 게이트가 관측시각(observedAtMs) 대신 경기별
// 처리시점 Date.now()로 회귀하면, LG는 관측간격 76초인데도 102초 stale로 오판돼 mark-only
// 억제되고 — 이 테스트가 그 회귀를 잡아낸다.
//
// game-status.ts는 import 시 supabase admin 싱글톤을 생성하므로 더미 env를 먼저 세팅하고
// dynamic import한다(실제 네트워크는 startDeps 주입으로 전혀 타지 않는다).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import type { KboRawGame } from "../../src/types/api";
import type { StartNotifyDeps } from "../../src/lib/notifications/game-status";

// tsx는 CJS로 트랜스파일하므로 top-level await 불가 → 각 테스트에서 lazy dynamic import.
const loadNotify = () =>
  import("../../src/lib/notifications/game-status").then((m) => m.notifyGameStatusTransitions);

const OBSERVED_AT = 1_784_800_000_000;

const BASE: KboRawGame = {
  G_ID: "", G_DT: "20260724", G_TM: "18:30", S_NM: "잠실",
  AWAY_ID: "", HOME_ID: "", AWAY_NM: "", HOME_NM: "",
  T_SCORE_CN: "0", B_SCORE_CN: "0",
  GAME_INN_NO: 1, GAME_TB_SC: "T", GAME_STATE_SC: "2", CANCEL_SC_ID: "0",
  T_PIT_P_NM: "", B_PIT_P_NM: "", W_PIT_P_NM: "", L_PIT_P_NM: "", SV_PIT_P_NM: "",
  STRIKE_CN: 0, BALL_CN: 0, OUT_CN: 0,
  B1_BAT_ORDER_NO: 0, B2_BAT_ORDER_NO: 0, B3_BAT_ORDER_NO: 0,
  B_P_NM: "", T_P_NM: "", T_RANK_NO: 0, B_RANK_NO: 0,
};
const liveGame = (over: Partial<KboRawGame>): KboRawGame => ({ ...BASE, ...over });

const gameIdFromUrl = (url: string | undefined): string => (url ?? "").replace("/games/", "");

// game_notify_state.last_seen_scheduled_at 저장소 모델. `monotonic`은 마이그레이션 RPC
// mark_scheduled_seen()의 GREATEST(existing, observed) 의미를 그대로 반영한다(과거 방향
// 갱신 무시). `!monotonic`은 회귀 사례(unconditional upsert = last-write-wins)를 재현한다.
function makeStore(monotonic: boolean) {
  const seen = new Map<string, number>(); // gameId → last_seen_scheduled_at(ms)
  const started = new Set<string>();
  const sent: string[] = [];
  const marked: string[] = [];
  const deps: StartNotifyDeps = {
    storeScheduledSeen: async (ids, iso) => {
      const ms = Date.parse(iso);
      for (const id of ids) {
        const prev = seen.get(id);
        seen.set(id, monotonic && prev !== undefined ? Math.max(prev, ms) : ms);
      }
    },
    readStartState: async (id) => ({
      start_notified: started.has(id),
      last_seen_scheduled_at: seen.has(id) ? new Date(seen.get(id)!).toISOString() : null,
    }),
    claimStart: async (id) => { if (started.has(id)) return false; started.add(id); return true; },
    unclaimStart: async (id) => { started.delete(id); },
    markStart: async (id) => { marked.push(id); },
    fansOf: async () => ({ ids: ["u1"], ok: true }),
    sendStart: async (ids, payload) => { sent.push(gameIdFromUrl(payload.url)); return { ok: true, sent: ids.length }; },
  };
  return { deps, sent, marked };
}

const schedGame = (over: Partial<KboRawGame>): KboRawGame => liveGame({ GAME_STATE_SC: "1", ...over });

test("배선 회귀: 앞 경기 FCM 26초 지연이 뒤 경기(LG) 시작알림을 억제하지 않는다 (관측시각 기준)", async () => {
  // 두 경기 모두 직전 틱에서 76초 전 '예정'을 관측(관측상 연속 → 정상 발송 대상).
  const seenIso = new Date(OBSERVED_AT - 76_000).toISOString();
  // 앞 경기(삼성:KIA) → 뒤 경기(한화:LG) 순으로 처리.
  const games = [
    liveGame({ G_ID: "20260724SSKI0", AWAY_NM: "삼성", HOME_NM: "KIA" }),
    liveGame({ G_ID: "20260724HHLG0", AWAY_NM: "한화", HOME_NM: "LG" }),
  ];

  const sentGameIds: string[] = [];
  const markedGameIds: string[] = [];
  // 실제 코드가 관측시각 대신 Date.now()로 회귀하면 이 clock을 읽어 오판하도록, Date.now를 제어.
  let clock = OBSERVED_AT;
  const realNow = Date.now;
  Date.now = () => clock;
  let firstSend = true;

  const deps: StartNotifyDeps = {
    storeScheduledSeen: async () => {},
    readStartState: async () => ({ start_notified: false, last_seen_scheduled_at: seenIso }),
    claimStart: async () => true,
    unclaimStart: async () => {},
    markStart: async (gameId) => { markedGameIds.push(gameId); },
    fansOf: async () => ({ ids: ["u1"], ok: true }),
    sendStart: async (ids, payload) => {
      sentGameIds.push(gameIdFromUrl(payload.url));
      // 앞 경기의 첫 발송(메인 "⚾ 경기 시작!")이 26초 걸린 것으로 시뮬레이션 → 처리시점 전진.
      if (firstSend) { firstSend = false; clock += 26_000; }
      return { ok: true, sent: ids.length };
    },
  };

  try {
    const notifyGameStatusTransitions = await loadNotify();
    const res = await notifyGameStatusTransitions(games, { observedAtMs: OBSERVED_AT, startDeps: deps });
    // 앞 경기(삼성:KIA)는 물론, clock이 +26초 전진한 뒤 처리된 LG도 관측시각 기준으로 발송돼야 한다.
    assert.ok(sentGameIds.includes("20260724HHLG0"), "LG 경기 시작알림이 발송돼야 한다(관측시각 76초=연속)");
    assert.ok(!markedGameIds.includes("20260724HHLG0"), "LG가 mark-only로 억제되면 안 된다(게이트가 Date.now()로 회귀한 사고)");
    assert.ok(sentGameIds.includes("20260724SSKI0"), "앞 경기(삼성:KIA)도 발송돼야 한다");
    assert.equal(res.started, 2, "두 경기 모두 시작 발송 카운트");
  } finally {
    Date.now = realNow;
  }
});

test("배선 회귀: 예정 관측 기록(last_seen_scheduled_at)은 처리시점이 아니라 관측시각으로 저장된다", async () => {
  // Date.now()를 관측시각과 크게 다른 값으로 고정 → 저장값이 Date.now()가 아니라 observedAtMs여야.
  let stored: { ids: string[]; iso: string } | null = null;
  const realNow = Date.now;
  Date.now = () => OBSERVED_AT + 999_000; // 처리시점이 관측보다 999초 뒤였다고 가정
  const deps: StartNotifyDeps = {
    storeScheduledSeen: async (ids, iso) => { stored = { ids, iso }; },
    readStartState: async () => null,
    claimStart: async () => true,
    unclaimStart: async () => {},
    markStart: async () => {},
    fansOf: async () => ({ ids: [], ok: true }),
    sendStart: async () => ({ ok: true, sent: 0 }),
  };
  try {
    const notifyGameStatusTransitions = await loadNotify();
    const games = [liveGame({ G_ID: "20260724HTNC0", AWAY_NM: "KT", HOME_NM: "NC", GAME_STATE_SC: "1" })];
    await notifyGameStatusTransitions(games, { observedAtMs: OBSERVED_AT, startDeps: deps });
    assert.ok(stored, "예정 경기 관측이 기록돼야 한다");
    assert.equal(stored!.iso, new Date(OBSERVED_AT).toISOString(), "관측시각으로 저장(처리시점 Date.now() 아님)");
    assert.deepEqual(stored!.ids, ["20260724HTNC0"]);
  } finally {
    Date.now = realNow;
  }
});

// ── 겹친 cron 단조(monotonic) 저장 순서 회귀 (삼순 #815 재리뷰 blocker) ──────────────
// 시나리오: scheduled@t60 저장 → (겹친 이전 invocation이 뒤늦게) scheduled@t0 저장 →
// live@t120 판정. 오래된 t0가 최신 t60을 뒤로 덮으면(last-write-wins), live@t120이
// 관측간격을 120초로 오판해 mark-only 억제한다. 단조 저장이면 t60이 유지돼 60초=정상 발송.
const GID = "20260724HHLG0"; // 한화:LG
const T0 = OBSERVED_AT;
const T60 = OBSERVED_AT + 60_000;
const T120 = OBSERVED_AT + 120_000;

async function driveOverlappingSequence(monotonic: boolean) {
  const notify = await loadNotify();
  const s = makeStore(monotonic);
  // tick1: 예정 관측 @t60 (최신)
  await notify([schedGame({ G_ID: GID, AWAY_NM: "한화", HOME_NM: "LG" })], { observedAtMs: T60, startDeps: s.deps });
  // tick2: 겹친 이전 invocation이 뒤늦게 끝나 자기 관측 @t0(과거)으로 write
  await notify([schedGame({ G_ID: GID, AWAY_NM: "한화", HOME_NM: "LG" })], { observedAtMs: T0, startDeps: s.deps });
  // tick3: live 전환 관측 @t120
  await notify([liveGame({ G_ID: GID, AWAY_NM: "한화", HOME_NM: "LG", GAME_STATE_SC: "2", GAME_INN_NO: 1, GAME_TB_SC: "T" })],
    { observedAtMs: T120, startDeps: s.deps });
  return s;
}

test("단조 저장 회귀: 겹친 cron에서 뒤늦은 과거 관측이 최신값을 덮지 않아 live@t120 시작알림 정상 발송", async () => {
  const s = await driveOverlappingSequence(true); // GREATEST(t60, t0)=t60 유지 → gap 60s ≤ 90s
  assert.ok(s.sent.includes(GID), "단조 저장이면 last_seen=t60 유지 → LG 시작알림 발송");
  assert.ok(!s.marked.includes(GID), "mark-only 억제되면 안 됨");
});

test("단조 저장 회귀(음성 대조): last-write-wins면 과거 t0가 최신을 덮어 live@t120이 stale 오판·억제", async () => {
  const s = await driveOverlappingSequence(false); // 덮어써 last_seen=t0 → gap 120s > 90s
  assert.ok(s.marked.includes(GID), "덮어쓰기면 stale(120s) 오판 → mark-only 억제(회귀 재현)");
  assert.ok(!s.sent.includes(GID), "억제 시 발송 없음");
});

test("device snapshot이 열린 게임은 다음 cron의 freshness stale 판정으로 global mark-only 종결하지 않는다", async () => {
  const notify = await loadNotify();
  const marked: string[] = [];
  const delivered: string[] = [];
  const game = liveGame({
    G_ID: GID,
    AWAY_NM: "한화",
    HOME_NM: "LG",
    GAME_INN_NO: 2,
    GAME_TB_SC: "B",
  });
  const result = await notify([game], {
    observedAtMs: T120 + 120_000,
    startDeps: {
      storeScheduledSeen: async () => {},
      readStartState: async () => ({
        start_notified: false,
        last_seen_scheduled_at: new Date(T0).toISOString(),
        start_snapshot_at: new Date(T60).toISOString(),
      }),
      markStart: async (id) => { marked.push(id); },
      deliverStart: async ({ gameId }) => {
        delivered.push(gameId);
        return {
          snapshotCompleted: false,
          fcmAcceptedDelta: 0,
          fcmAcceptedTotal: 0,
          deviceDelivered: null,
          pending: 1,
          permanentFailed: 0,
          expired: 0,
        };
      },
    },
  });
  assert.deepEqual(delivered, [GID], "기존 snapshot drain 경로를 계속 타야 한다");
  assert.deepEqual(marked, [], "snapshot 완료 전 mark-only global 종결 금지");
  assert.equal(result.started, 0);
});

test("start 관제 started는 snapshot 누계가 아니라 이번 invocation accepted delta만 합산", async () => {
  const notify = await loadNotify();
  const result = await notify([liveGame({
    G_ID: GID,
    AWAY_NM: "한화",
    HOME_NM: "LG",
    GAME_INN_NO: 1,
    GAME_TB_SC: "T",
  })], {
    observedAtMs: T120,
    startDeps: {
      storeScheduledSeen: async () => {},
      readStartState: async () => ({
        start_notified: false,
        last_seen_scheduled_at: new Date(T60).toISOString(),
        start_snapshot_at: new Date(T60).toISOString(),
      }),
      deliverStart: async () => ({
        snapshotCompleted: false,
        fcmAcceptedDelta: 7,
        fcmAcceptedTotal: 100,
        deviceDelivered: null,
        pending: 1,
        permanentFailed: 0,
        expired: 0,
      }),
    },
  });
  assert.equal(result.started, 7);
});

test("17:59:15 scheduled → 18:02:46 live 1회초는 mark-only 대신 snapshot/delivery를 연다", async () => {
  const notify = await loadNotify();
  const liveAt = Date.UTC(2026, 6, 26, 9, 2, 46); // KST 18:02:46
  const opened: string[] = [];
  const delivered: string[] = [];
  const marked: string[] = [];
  let claimed = false;
  const realNow = Date.now;
  Date.now = () => liveAt;
  try {
    const result = await notify([liveGame({
      G_ID: "20260726LGHH0",
      G_DT: "20260726",
      G_TM: "18:00",
      AWAY_NM: "LG",
      HOME_NM: "한화",
      GAME_INN_NO: 1,
      GAME_TB_SC: "T",
    })], {
      observedAtMs: liveAt,
      deadlineAtMs: liveAt + 52_000,
      startDeps: {
        storeScheduledSeen: async () => {},
        readStartState: async () => ({
          start_notified: false,
          last_seen_scheduled_at: new Date(liveAt - 211_000).toISOString(),
        }),
        markStart: async (id) => { marked.push(id); },
        openStart: async ({ gameId }) => {
          opened.push(gameId);
          return liveAt + 90_000;
        },
        deliverStartBatch: async ({ gameId }) => {
          if (claimed) {
            return {
              claimed: 0, snapshotCompleted: true, fcmAcceptedDelta: 0, fcmAcceptedTotal: 1,
              deviceDelivered: null, pending: 0, permanentFailed: 0, expired: 0,
            };
          }
          claimed = true;
          delivered.push(gameId);
          return {
            claimed: 1,
            snapshotCompleted: true,
            fcmAcceptedDelta: 1,
            fcmAcceptedTotal: 1,
            deviceDelivered: null,
            pending: 0,
            permanentFailed: 0,
            expired: 0,
          };
        },
        finalizeStart: async (_gameId, delta = 0) => ({
          snapshotCompleted: true,
          fcmAcceptedDelta: delta,
          fcmAcceptedTotal: delta,
          deviceDelivered: null,
          pending: 0,
          permanentFailed: 0,
          expired: 0,
        }),
      },
    });
    assert.deepEqual(opened, ["20260726LGHH0"]);
    assert.deepEqual(delivered, ["20260726LGHH0"]);
    assert.deepEqual(marked, []);
    assert.equal(result.started, 1);
  } finally {
    Date.now = realNow;
  }
});

test("오늘 5경기 13,454행은 bounded parallel + batch p95 1.4초·첫 8초 transient에도 전량 drain", async () => {
  const notify = await loadNotify();
  const gameIds = ["G1", "G2", "G3", "G4", "G5"];
  const sizes = [3_419, 2_233, 1_191, 3_492, 3_119];
  const remaining = new Map(gameIds.map((id, index) => [id, sizes[index]]));
  const accepted = new Map(gameIds.map((id) => [id, 0]));
  const opened: string[] = [];
  const firstAttempted = new Set<string>();
  let clock = OBSERVED_AT;
  let firstSlowTransient = true;
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    const result = await notify(gameIds.map((gameId, index) => liveGame({
      G_ID: gameId,
      G_DT: "20260724",
      G_TM: "18:30",
      AWAY_NM: index % 2 === 0 ? "한화" : "LG",
      HOME_NM: index % 2 === 0 ? "LG" : "한화",
    })), {
      observedAtMs: OBSERVED_AT,
      deadlineAtMs: OBSERVED_AT + 52_000,
      startDeps: {
        storeScheduledSeen: async () => {},
        readStartState: async () => ({
          start_notified: false,
          last_seen_scheduled_at: new Date(OBSERVED_AT - 60_000).toISOString(),
        }),
        markStart: async () => {},
        openStart: async ({ gameId }) => {
          opened.push(gameId);
          return OBSERVED_AT + 90_000;
        },
        deliverStartBatch: async ({ gameId, attemptDeadlineAtMs }) => {
          assert.equal(opened.length, 5, "첫 FCM batch 전에 5경기 snapshot을 모두 열어야 한다");
          assert.ok(clock < OBSERVED_AT + 52_000, "route deadline 뒤 신규 batch 금지");
          assert.ok(attemptDeadlineAtMs <= clock + 14_000, "send+settle attempt budget은 14초 이하");
          firstAttempted.add(gameId);
          if (remaining.get(gameId) === 0) {
            return {
              claimed: 0, snapshotCompleted: true, fcmAcceptedDelta: 0,
              fcmAcceptedTotal: accepted.get(gameId)!, deviceDelivered: null,
              pending: 0, permanentFailed: 0, expired: 0,
            };
          }
          if (gameId === "G1" && firstSlowTransient) {
            firstSlowTransient = false;
            clock += 8_000;
            return {
              claimed: 500,
              snapshotCompleted: false,
              fcmAcceptedDelta: 0,
              fcmAcceptedTotal: 0,
              deviceDelivered: null,
              pending: remaining.get(gameId)!,
              permanentFailed: 0,
              expired: 0,
            };
          }
          const delta = Math.min(500, remaining.get(gameId)!);
          remaining.set(gameId, remaining.get(gameId)! - delta);
          accepted.set(gameId, accepted.get(gameId)! + delta);
          // 28개 FCM batch 전체에 운영 p95 1.4초를 적용한다(첫 transient만 8초 worst case).
          // fake clock은 병렬 호출도 보수적으로 직렬 합산하므로 52초 통과는 실제보다 엄격하다.
          clock += 1_400;
          return {
            claimed: delta,
            snapshotCompleted: remaining.get(gameId) === 0,
            fcmAcceptedDelta: delta,
            fcmAcceptedTotal: accepted.get(gameId)!,
            deviceDelivered: null,
            pending: remaining.get(gameId)!,
            permanentFailed: 0,
            expired: 0,
          };
        },
        finalizeStart: async (gameId, delta = 0) => ({
          snapshotCompleted: remaining.get(gameId) === 0,
          fcmAcceptedDelta: delta,
          fcmAcceptedTotal: accepted.get(gameId)!,
          deviceDelivered: null,
          pending: remaining.get(gameId)!,
          permanentFailed: 0,
          expired: 0,
        }),
      },
    });
    assert.deepEqual(opened, gameIds);
    assert.deepEqual([...firstAttempted], gameIds);
    assert.ok([...remaining.values()].every((count) => count === 0));
    assert.equal(result.started, sizes.reduce((sum, count) => sum + count, 0));
    assert.ok(clock < OBSERVED_AT + 52_000);
  } finally {
    Date.now = realNow;
  }
});

test("DB start-state 조회 실패는 mark/open 없이 fail-close하고 다음 cron에 재시도", async () => {
  const notify = await loadNotify();
  const marked: string[] = [];
  const opened: string[] = [];
  const gameId = "20260726LGHH0";
  const result = await notify([liveGame({
    G_ID: gameId, AWAY_NM: "LG", HOME_NM: "한화",
  })], {
    observedAtMs: OBSERVED_AT,
    startPlateAppearanceByGame: new Map([[
      gameId,
      { completedPlateAppearances: 0, currentBatterIsLeadoff: true },
    ]]),
    startDeps: {
      storeScheduledSeen: async () => {},
      readStartState: async () => { throw new Error("db timeout"); },
      markStart: async (id) => { marked.push(id); },
      openStart: async ({ gameId: id }) => { opened.push(id); return OBSERVED_AT + 90_000; },
    },
  });
  assert.deepEqual(marked, []);
  assert.deepEqual(opened, []);
  assert.equal(result.started, 0);
});

test("첫 타석 종료·2번 타자 진입 근거는 snapshot을 열지 않고 mark-only", async () => {
  const notify = await loadNotify();
  const marked: string[] = [];
  const opened: string[] = [];
  const gameId = "20260726LGHH0";
  await notify([liveGame({
    G_ID: gameId, AWAY_NM: "LG", HOME_NM: "한화",
  })], {
    observedAtMs: OBSERVED_AT,
    startPlateAppearanceByGame: new Map([[
      gameId,
      { completedPlateAppearances: 1, currentBatterIsLeadoff: false },
    ]]),
    startDeps: {
      storeScheduledSeen: async () => {},
      readStartState: async () => ({
        start_notified: false,
        last_seen_scheduled_at: new Date(OBSERVED_AT - 60_000).toISOString(),
      }),
      markStart: async (id) => { marked.push(id); },
      openStart: async ({ gameId: id }) => { opened.push(id); return OBSERVED_AT + 90_000; },
    },
  });
  assert.deepEqual(marked, [gameId]);
  assert.deepEqual(opened, []);
});

test("warmup 배선: 초기 fetch 직후 start 근거 수집, start barrier 뒤 highlight release", () => {
  const route = readFileSync("src/app/api/cron/game-events-warmup/route.ts", "utf8");
  const initialEvents = route.indexOf("const initialGameEventsPromise");
  const laStart = route.indexOf("const laOrchestration = startLaOrchestration");
  const startNotify = route.indexOf("gameNotify = await notifyGameStatusTransitions");
  const highlightNotify = route.indexOf("highlightNotify = await notifyPlayerHighlights");
  assert.ok(initialEvents >= 0 && initialEvents < laStart, "game-events/start 근거 fetch는 초기 KBO fetch 직후 시작");
  assert.ok(startNotify >= 0 && startNotify < highlightNotify, "start accepted barrier 뒤 highlight 발송");
  assert.match(route, /startBlockedGameIds:\s*new Set/);
});

// 마이그레이션 계약 — 저장이 앱-레벨 read-modify-write(레이시)가 아니라 DB 원자 단조여야 한다.
test("마이그레이션 계약: mark_scheduled_seen RPC는 ON CONFLICT + GREATEST 원자 단조 저장", () => {
  const sql = readFileSync("supabase/migrations/20260724_notify_scheduled_seen_monotonic.sql", "utf8").toLowerCase();
  assert.match(sql, /create or replace function\s+mark_scheduled_seen/);
  assert.match(sql, /on conflict\s*\(game_id\)\s*do update/);
  assert.match(sql, /greatest\(\s*game_notify_state\.last_seen_scheduled_at\s*,\s*excluded\.last_seen_scheduled_at\s*\)/);
  assert.match(sql, /grant execute on function mark_scheduled_seen\(text\[\], timestamptz\) to service_role/);
  // 과거 방향으로 무조건 덮는 last-write-wins 패턴이 없어야 한다.
  assert.doesNotMatch(sql, /set last_seen_scheduled_at\s*=\s*excluded\.last_seen_scheduled_at\s*;/);
});

// 배선 실행 검증 — 프로덕션 기본 저장(storeScheduledSeen 미주입)이 naive .from().upsert()가
// 아니라 원자 단조 RPC mark_scheduled_seen 을 호출하는지, admin 싱글톤 .rpc/.from 을 스파이해
// 실제 notifyGameStatusTransitions() 실행으로 확인한다(소스 grep 아님).
test("배선: 프로덕션 기본 저장은 mark_scheduled_seen RPC(원자 단조) 호출 — naive upsert 아님", async () => {
  const admin = await import("../../src/lib/supabase/admin");
  const client = admin.supabaseAdmin as unknown as {
    rpc: (name: string, args: unknown) => Promise<{ data: null; error: null }>;
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
    await notify([schedGame({ G_ID: "20260724HTNC0", AWAY_NM: "KT", HOME_NM: "NC" })], {
      observedAtMs: OBSERVED_AT,
      // storeScheduledSeen 는 일부러 미주입 → 프로덕션 defaultStoreScheduledSeen 경로 실행.
      startDeps: {
        readStartState: async () => null,
        claimStart: async () => true,
        unclaimStart: async () => {},
        markStart: async () => {},
        fansOf: async () => ({ ids: [], ok: true }),
        sendStart: async () => ({ ok: true, sent: 0 }),
      },
    });
    const call = rpcCalls.find((c) => c.name === "mark_scheduled_seen");
    assert.ok(call, "기본 저장은 mark_scheduled_seen RPC 호출");
    assert.deepEqual((call!.args as { p_game_ids: string[] }).p_game_ids, ["20260724HTNC0"]);
    assert.equal((call!.args as { p_observed_at: string }).p_observed_at, new Date(OBSERVED_AT).toISOString());
    assert.equal(fromCalled, false, "naive .from().upsert() 경로가 아니라 원자 RPC만 사용");
  } finally {
    client.rpc = origRpc;
    client.from = origFrom;
  }
});

// 실행 동작은 qa:la-born-marking이 검증한다. 여기서는 production 함수가 그 검증된
// actual-marking budget helper를 경기 루프 밖에서 1회 만들고 양 팀에 전달하는지만 고정한다.
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
