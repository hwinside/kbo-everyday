// QA 스모크 — 라이브 fast path 서브틱(live-fast-path.ts)의 diff 게이트/중복 발송 가드/
// 경로 격리/순서 불변식 검증. 주입 의존성으로 network/supabase/APNs/FCM 없이 동작.
//  - 서브틱 dedupe: 같은 득점이 서브틱 2회에 걸쳐 1회만 발송(게이트 레벨 — claim 레벨은
//    qa:push-score-events의 notified_score_events PK가 커버).
//  - 무변화 틱: DB/APNs/FCM 의존성 어디에도 접근하지 않음(7/22 conn pool 장애 재발 방지).
//  - 순서 불변식: 레거시 per-토큰 LA → broadcast (채널 hash 전진 순서).
import type { KboRawGame } from "../../src/types/api";
import type { GameEvent } from "../../src/types/game-events";
import {
  scoreAxisSignature,
  liveCardSignature,
  seedLiveFastPathState,
  diffAndAdvance,
  runLiveFastPathTick,
  type LiveFastPathDeps,
} from "../../src/lib/notifications/live-fast-path";

let pass = 0;
let fail = 0;
function check(name: string, got: unknown, want: unknown) {
  if (got === want) { pass++; }
  else { fail++; console.error(`✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

function game(over: Partial<KboRawGame> = {}): KboRawGame {
  return {
    G_ID: "20260723LGOB0",
    GAME_STATE_SC: "2",
    AWAY_NM: "LG",
    HOME_NM: "두산",
    T_SCORE_CN: "1",
    B_SCORE_CN: "0",
    GAME_INN_NO: 4,
    GAME_TB_SC: "T",
    OUT_CN: 1,
    B1_BAT_ORDER_NO: 3,
    B2_BAT_ORDER_NO: 0,
    B3_BAT_ORDER_NO: 0,
    T_P_NM: "홍창기",
    B_P_NM: "곽빈",
    CANCEL_SC_ID: "",
    S_NM: "잠실",
    ...over,
  } as unknown as KboRawGame;
}

// ── 시그니처 축 ──
check("sig: 점수축 — 동일 상태 동일", scoreAxisSignature(game()), scoreAxisSignature(game()));
check("sig: 점수축 — 득점 변화 감지",
  scoreAxisSignature(game()) !== scoreAxisSignature(game({ B_SCORE_CN: "1" })), true);
check("sig: 점수축 — 타자 교체는 비변화(타석마다 이벤트 fetch 방지)",
  scoreAxisSignature(game()), scoreAxisSignature(game({ T_P_NM: "오스틴" })));
check("sig: 카드축 — 아웃 변화 감지",
  liveCardSignature(game()) !== liveCardSignature(game({ OUT_CN: 2 })), true);
check("sig: 카드축 — 주자 변화 감지",
  liveCardSignature(game()) !== liveCardSignature(game({ B2_BAT_ORDER_NO: 5 })), true);
check("sig: 카드축 — 상태 전환(live→final) 감지",
  liveCardSignature(game()) !== liveCardSignature(game({ GAME_STATE_SC: "3" })), true);

// ── diff/advance ──
{
  const st = seedLiveFastPathState([game()]);
  const d1 = diffAndAdvance(st, [game()]);
  check("diff: baseline 동일 → 무변화", d1.changedGameIds.length, 0);
  const d2 = diffAndAdvance(st, [game({ B_SCORE_CN: "1" })]);
  check("diff: 득점 → 카드축+점수축 변화", d2.changedGameIds.length === 1 && d2.scoreChangedLiveGameIds.length === 1, true);
  const d3 = diffAndAdvance(st, [game({ B_SCORE_CN: "1" })]);
  check("diff: state 전진 후 동일 스냅샷 → 무변화(서브틱 dedupe)", d3.changedGameIds.length, 0);
  const d4 = diffAndAdvance(st, [game({ B_SCORE_CN: "1", OUT_CN: 2 })]);
  check("diff: 아웃만 변화 → 카드축만(점수축 비변화)", d4.changedGameIds.length === 1 && d4.scoreChangedLiveGameIds.length === 0, true);
  const d5 = diffAndAdvance(st, [game({ B_SCORE_CN: "1", OUT_CN: 2, GAME_STATE_SC: "3" })]);
  check("diff: final 전환은 카드축 변화(end 빠른 반영), 라이브 아님 → 점수 fetch 제외",
    d5.changedGameIds.length === 1 && d5.scoreChangedLiveGameIds.length === 0, true);
}
{
  // 초기 fetch 실패 → 빈 baseline → 첫 성공 서브틱이 전 경기를 변화로 보고 그 분 복구.
  const st = seedLiveFastPathState([]);
  const d = diffAndAdvance(st, [game()]);
  check("diff: 빈 baseline(초기 fetch 실패) → 전 경기 변화 처리", d.changedGameIds.length, 1);
}

// ── 오케스트레이션 하니스 ──
type Calls = {
  relay: number; android: number; legacyLa: number; broadcast: number;
  iosWidget: number; events: number; score: number; order: string[];
};
function makeDeps(over: Partial<LiveFastPathDeps> = {}): { deps: LiveFastPathDeps; calls: Calls } {
  const calls: Calls = { relay: 0, android: 0, legacyLa: 0, broadcast: 0, iosWidget: 0, events: 0, score: 0, order: [] };
  const deps: LiveFastPathDeps = {
    now: () => 1_000,
    fetchRelayLines: async () => { calls.relay++; return new Map([["20260723LGOB0", "김현수 안타"]]); },
    pushAndroid: async () => { calls.android++; calls.order.push("android"); return { sent: 1 }; },
    pushLegacyLa: async () => { calls.legacyLa++; calls.order.push("legacyLa"); return { pushed: 1 }; },
    pushBroadcast: async () => { calls.broadcast++; calls.order.push("broadcast"); return { updates: 1 }; },
    pushIosWidget: async () => { calls.iosWidget++; calls.order.push("iosWidget"); return { sent: 1 }; },
    fetchGameEvents: async (ids) => {
      calls.events++;
      return new Map<string, GameEvent[]>(ids.map((id) => [id, [] as GameEvent[]]));
    },
    notifyScore: async () => { calls.score++; return { scored: 1, conceded: 0 }; },
    ...over,
  };
  return { deps, calls };
}
const TRACE = { sourceAtMs: 500, fetchedAtMs: 600 };

(async () => {
  // 무변화 틱 → 어떤 의존성도 호출하지 않음 (DB/APNs/FCM 무접근 — conn pool 보호).
  {
    const { deps, calls } = makeDeps();
    const st = seedLiveFastPathState([game()]);
    const r = await runLiveFastPathTick(deps, st, [game()], TRACE);
    check("tick: 무변화 → skipped no_diff", (r as { skipped?: string }).skipped, "no_diff");
    check("tick: 무변화 → 의존성 호출 0",
      calls.relay + calls.android + calls.legacyLa + calls.broadcast + calls.iosWidget + calls.events + calls.score, 0);
  }
  // 득점 → 전 경로 발사 + 순서 불변식(legacyLa → broadcast → iosWidget).
  {
    const { deps, calls } = makeDeps();
    const st = seedLiveFastPathState([game()]);
    const r = await runLiveFastPathTick(deps, st, [game({ B_SCORE_CN: "1" })], TRACE);
    check("tick: 득점 → android/legacyLa/broadcast/iosWidget/score 각 1회",
      calls.android === 1 && calls.legacyLa === 1 && calls.broadcast === 1 && calls.iosWidget === 1 && calls.events === 1 && calls.score === 1, true);
    const laOrder = calls.order.filter((o) => o !== "android");
    check("tick: 순서 불변식 legacyLa→broadcast→iosWidget", laOrder.join(","), "legacyLa,broadcast,iosWidget");
    check("tick: detect→send 계측 존재", (r as { detectToSendMs?: number }).detectToSendMs, 400);
  }
  // 서브틱 dedupe — 같은 득점이 서브틱 2회에 걸쳐 1회만 발송(두 번째 틱은 게이트에서 no-op).
  {
    const { deps, calls } = makeDeps();
    const st = seedLiveFastPathState([game()]);
    await runLiveFastPathTick(deps, st, [game({ B_SCORE_CN: "1" })], TRACE);
    const r2 = await runLiveFastPathTick(deps, st, [game({ B_SCORE_CN: "1" })], TRACE);
    check("tick: 같은 득점 2번째 서브틱 → no_diff", (r2 as { skipped?: string }).skipped, "no_diff");
    check("tick: 득점 푸시 총 1회(서브틱 dedupe)", calls.score, 1);
    check("tick: LA broadcast 총 1회(서브틱 dedupe)", calls.broadcast, 1);
  }
  // 아웃/타자만 변화(점수축 비변화) → 카드 경로만, game-events fetch/득점 푸시 스킵.
  {
    const { deps, calls } = makeDeps();
    const st = seedLiveFastPathState([game()]);
    const r = await runLiveFastPathTick(deps, st, [game({ OUT_CN: 2, T_P_NM: "오스틴" })], TRACE);
    check("tick: 카드만 변화 → 발송 경로 실행", calls.broadcast === 1 && calls.android === 1, true);
    check("tick: 카드만 변화 → 이벤트 fetch 0(원천 호출 서브틱당 1회 원칙)", calls.events, 0);
    check("tick: 카드만 변화 → score skipped", ((r as { score?: unknown }).score as { skipped?: string })?.skipped, "no_score_diff");
  }
  // relay 실패 격리 — 줄만 안 뜨고 발송 경로는 그대로.
  {
    const { deps, calls } = makeDeps({ fetchRelayLines: async () => { throw new Error("relay down"); } });
    const st = seedLiveFastPathState([game()]);
    await runLiveFastPathTick(deps, st, [game({ B_SCORE_CN: "1" })], TRACE);
    check("tick: relay 실패에도 broadcast 실행", calls.broadcast, 1);
    check("tick: relay 실패에도 score 실행", calls.score, 1);
  }
  // 한 경로 오류 격리 — legacyLa 오류가 broadcast/score를 막지 않음.
  {
    const { deps, calls } = makeDeps({ pushLegacyLa: async () => { throw new Error("apns down"); } });
    const st = seedLiveFastPathState([game()]);
    const r = await runLiveFastPathTick(deps, st, [game({ B_SCORE_CN: "1" })], TRACE);
    check("tick: legacyLa 오류 격리 → broadcast 실행", calls.broadcast, 1);
    check("tick: legacyLa 오류 격리 → score 실행", calls.score, 1);
    check("tick: legacyLa 오류가 결과에 캡처", ((r as { legacyLa?: unknown }).legacyLa as { error?: string })?.error, "apns down");
  }
  // 이벤트 fetch 오류 → score 미실행(다음 분 cron이 claim 안 된 이벤트를 커버).
  {
    const { deps, calls } = makeDeps({ fetchGameEvents: async () => { throw new Error("events down"); } });
    const st = seedLiveFastPathState([game()]);
    await runLiveFastPathTick(deps, st, [game({ B_SCORE_CN: "1" })], TRACE);
    check("tick: 이벤트 fetch 오류 → notifyScore 미호출", calls.score, 0);
    check("tick: 이벤트 fetch 오류에도 카드 경로 실행", calls.broadcast, 1);
  }

  console.log(`\nlive-fast-path smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(1);
});
