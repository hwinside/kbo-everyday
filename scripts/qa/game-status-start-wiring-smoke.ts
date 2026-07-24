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
