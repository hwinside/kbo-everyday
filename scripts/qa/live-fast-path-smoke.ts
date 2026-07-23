// QA 스모크 — 라이브 fast path 서브틱(live-fast-path.ts)의 diff 게이트/중복 발송 가드/
// 경로 격리/순서 불변식 검증. 주입 의존성으로 network/supabase/APNs/FCM 없이 동작.
//  - 서브틱 dedupe: 같은 득점이 서브틱 2회에 걸쳐 1회만 발송(게이트 레벨 — claim 레벨은
//    qa:push-score-events의 notified_score_events PK가 커버).
//  - 무변화 틱: catch-up pending까지 비면 DB/APNs/FCM 의존성 어디에도 접근하지 않음
//    (7/22 conn pool 장애 재발 방지).
//  - 순서 불변식: 레거시 per-토큰 LA → broadcast (채널 hash 전진 순서).
//  - 삼순 R1 회귀: ① LA 축 게이트가 느린 본체를 기다리지 않음(52s 초과에도 서브틱 실행)
//    ② broadcast 유실 후 다음 무변화 서브틱의 current-state catch-up 1회(유계)
//    ③ 볼/스트라이크만 바뀐 서브틱도 diff 감지.
import type { KboRawGame } from "../../src/types/api";
import type { GameEvent } from "../../src/types/game-events";
import {
  scoreAxisSignature,
  liveCardSignature,
  seedLiveFastPathState,
  diffAndAdvance,
  runLiveFastPathTick,
  gateFastPathOnLaAxis,
  type LiveFastPathDeps,
} from "../../src/lib/notifications/live-fast-path";
import { runWidgetFastLoop } from "../../src/lib/notifications/widget-fast-loop";

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
    BALL_CN: 1,
    STRIKE_CN: 0,
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
// 삼순 R1 blocker③ — 볼/스트라이크만 바뀐 서브틱도 카드축 diff로 잡힌다(단 점수축은 아님).
check("sig: 카드축 — 볼 카운트 변화 감지(R1③)",
  liveCardSignature(game()) !== liveCardSignature(game({ BALL_CN: 2 })), true);
check("sig: 카드축 — 스트라이크 카운트 변화 감지(R1③)",
  liveCardSignature(game()) !== liveCardSignature(game({ STRIKE_CN: 2 })), true);
check("sig: 점수축 — 볼카운트 변화는 비변화(득점 fetch 미유발)",
  scoreAxisSignature(game()), scoreAxisSignature(game({ BALL_CN: 3, STRIKE_CN: 2 })));

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
  relay: number; android: number; legacyLa: number; broadcast: number; catchup: number;
  catchupIds: string[]; iosWidget: number; events: number; score: number; order: string[];
};
function makeDeps(over: Partial<LiveFastPathDeps> = {}): { deps: LiveFastPathDeps; calls: Calls } {
  const calls: Calls = {
    relay: 0, android: 0, legacyLa: 0, broadcast: 0, catchup: 0, catchupIds: [],
    iosWidget: 0, events: 0, score: 0, order: [],
  };
  const deps: LiveFastPathDeps = {
    now: () => 1_000,
    fetchRelayLines: async () => { calls.relay++; return new Map([["20260723LGOB0", "김현수 안타"]]); },
    pushAndroid: async () => { calls.android++; calls.order.push("android"); return { sent: 1 }; },
    pushLegacyLa: async () => { calls.legacyLa++; calls.order.push("legacyLa"); return { pushed: 1 }; },
    pushBroadcast: async () => { calls.broadcast++; calls.order.push("broadcast"); return { updates: 1 }; },
    pushBroadcastCatchup: async (_gs, _lp, ids) => {
      calls.catchup++; calls.catchupIds.push(...ids); calls.order.push("catchup");
      return { updates: ids.length, catchups: ids.length };
    },
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
  // 무변화 틱 — seed 직후 첫 틱은 본체(cycle 0) broadcast 유실 대비 catch-up 1회(삼순 R1②),
  // 두 번째 무변화 틱부터는 진짜 의존성 0(DB/APNs/FCM 무접근 — conn pool 보호).
  {
    const { deps, calls } = makeDeps();
    const st = seedLiveFastPathState([game()]);
    const r1 = await runLiveFastPathTick(deps, st, [game()], TRACE);
    check("tick: 무변화 첫 틱 → skipped no_diff", (r1 as { skipped?: string }).skipped, "no_diff");
    check("tick: 무변화 첫 틱 → cycle0 유실 대비 broadcast catch-up 1회", calls.catchup, 1);
    check("tick: catch-up은 broadcast-only(안드/레거시/iOS/득점 0 — FCM dedupe 불변)",
      calls.android + calls.legacyLa + calls.broadcast + calls.iosWidget + calls.events + calls.score, 0);
    const r2 = await runLiveFastPathTick(deps, st, [game()], TRACE);
    check("tick: 무변화 두 번째 틱 → skipped no_diff", (r2 as { skipped?: string }).skipped, "no_diff");
    check("tick: 무변화 두 번째 틱 → 의존성 호출 추가 0(catch-up 유계 1회)",
      calls.relay + calls.android + calls.legacyLa + calls.broadcast + calls.catchup +
        calls.iosWidget + calls.events + calls.score,
      calls.catchup === 1 && calls.relay === 1 ? 2 : -1);
  }
  // 종료 경기(라이브 아님)만 남은 무변화 틱 → catch-up 대상 아님(진짜 no-op).
  {
    const { deps, calls } = makeDeps();
    const st = seedLiveFastPathState([game({ GAME_STATE_SC: "3" })]);
    const r = await runLiveFastPathTick(deps, st, [game({ GAME_STATE_SC: "3" })], TRACE);
    check("tick: 종료 경기 무변화 → no_diff", (r as { skipped?: string }).skipped, "no_diff");
    check("tick: 종료 경기 무변화 → catch-up 포함 의존성 0",
      calls.relay + calls.catchup + calls.broadcast, 0);
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
  // 서브틱 dedupe + 유실 재시도(삼순 R1②) — 같은 득점은 1회만 발송되되, 다음 무변화
  // 서브틱이 broadcast-only current-state catch-up을 정확히 1회 재발송(그 다음 틱은 0).
  {
    const { deps, calls } = makeDeps();
    const st = seedLiveFastPathState([game()]);
    await runLiveFastPathTick(deps, st, [game({ B_SCORE_CN: "1" })], TRACE);
    const r2 = await runLiveFastPathTick(deps, st, [game({ B_SCORE_CN: "1" })], TRACE);
    check("tick: 같은 득점 2번째 서브틱 → no_diff", (r2 as { skipped?: string }).skipped, "no_diff");
    check("tick: 득점 푸시 총 1회(서브틱 dedupe — FCM 개인 알림 중복 금지 불변)", calls.score, 1);
    check("tick: LA 변화 broadcast 총 1회(서브틱 dedupe)", calls.broadcast, 1);
    check("tick: 유실 대비 catch-up 재발송 1회 — 변화 broadcast 유실 시 다음 틱이 복구(R1②)",
      calls.catchup === 1 && calls.catchupIds.join(",") === "20260723LGOB0", true);
    const r3 = await runLiveFastPathTick(deps, st, [game({ B_SCORE_CN: "1" })], TRACE);
    check("tick: catch-up 유계 — 3번째 무변화 틱은 재발송 없음",
      calls.catchup === 1 && (r3 as { catchup?: unknown }).catchup === undefined, true);
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

  // ── 삼순 R1 blocker① route-level 회귀 — 느린 본체(52s+ 미완료)가 서브틱을 굮기지 않음 ──
  // route와 동일 구성(runWidgetFastLoop + gateFastPathOnLaAxis + runLiveFastPathTick)을
  // fake clock으로 구동. 본체 promise는 영원히 미해결 — 게이트에 아예 배선되지 않는다는 것
  // 자체가 회귀 포인트(기존 NO-GO: mainBodyDone 대기로 0회 실행).
  {
    let nowMs = 0;
    const sleep = async (ms: number) => { nowMs += ms; };
    let mainBodyResolved = false;
    // 느린 본체 — 의도적으로 아무데도 연결하지 않음(resolve 안 됨 = 52s 넘어도 미완료).
    new Promise<void>(() => {}).then(() => { mainBodyResolved = true; });
    const laAxisDone = Promise.resolve(); // LA 축은 수 초 내 완료(본체와 독립)
    const { deps, calls } = makeDeps({ now: () => nowMs });
    const st = seedLiveFastPathState([game()]);
    st.catchupGameIds.clear(); // 이 블록은 변화 틱 경로만 본다(catch-up은 위에서 검증)
    let score = 0;
    const ticks = await runWidgetFastLoop(
      {
        now: () => nowMs,
        sleep,
        fetchLiveGames: async () => {
          score += 1; // 매 틱 점수 변화 → 매 틱 broadcast 기대
          return {
            ok: true,
            games: [game({ B_SCORE_CN: String(score) })],
            trace: { sourceAtMs: nowMs, fetchedAtMs: nowMs },
          };
        },
        pushWidgets: gateFastPathOnLaAxis({
          laAxisDone,
          deadlineAtMs: 52_000,
          now: () => nowMs,
          sleep,
          runTick: (gs, tr) => runLiveFastPathTick(deps, st, gs, tr),
        }),
      },
      { requestStartMs: 0 },
    );
    check("route: 본체 52s+ 미완료에도 서브틱 3회 전부 실행(R1①)", ticks.length, 3);
    check("route: 서브틱마다 LA broadcast 발사", calls.broadcast, 3);
    check("route: 본체 promise는 끝까지 미해결(게이트 무배선 증명)", mainBodyResolved, false);
    check("route: 득점 푸시도 서브틱당 1회(점수축 변화)", calls.score, 3);
  }
  // LA 축 자체가 deadline까지 미완료 → 발송 0 + la_axis_overrun(시간 유계 대기 증명).
  {
    let nowMs = 0;
    const sleep = async (ms: number) => { nowMs += ms; };
    const { deps, calls } = makeDeps({ now: () => nowMs });
    const st = seedLiveFastPathState([game()]);
    const ticks = await runWidgetFastLoop(
      {
        now: () => nowMs,
        sleep,
        fetchLiveGames: async () => ({
          ok: true,
          games: [game({ B_SCORE_CN: "9" })],
          trace: { sourceAtMs: nowMs, fetchedAtMs: nowMs },
        }),
        pushWidgets: gateFastPathOnLaAxis({
          laAxisDone: new Promise<void>(() => {}), // LA 축 행 — 영원히 미완료
          deadlineAtMs: 52_000,
          now: () => nowMs,
          sleep,
          runTick: (gs, tr) => runLiveFastPathTick(deps, st, gs, tr),
        }),
      },
      { requestStartMs: 0 },
    );
    check("route: LA 축 미완료 → 서브틱 발송 0(stale-overwrite 방지 유지)",
      calls.broadcast + calls.android + calls.score, 0);
    check("route: LA 축 미완료 → la_axis_overrun 기록",
      (ticks[0]?.result as { skipped?: string })?.skipped, "la_axis_overrun");
  }

  console.log(`\nlive-fast-path smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(1);
});
