// QA 스모크 — 라이브 fast path 서브틱(live-fast-path.ts)의 diff 게이트/중복 발송 가드/
// 경로 격리/broadcast 크리티컬 패스 분리 검증. 주입 의존성으로 network/supabase/APNs/FCM
// 없이 동작.
//  - 서브틱 dedupe: 같은 득점이 서브틱 2회에 걸쳐 1회만 발송(게이트 레벨 — claim 레벨은
//    qa:push-score-events의 notified_score_events PK가 커버).
//  - 무변화 틱: catch-up pending까지 비면 DB/APNs/FCM 의존성 어디에도 접근하지 않음
//    (7/22 conn pool 장애 재발 방지).
//  - 삼순 R2 회귀: ① broadcast 크리티컬 패스(스냅샷→broadcast)와 느린 fanout(레거시/
//    start/iOS 위젯) 분리 — *route와 동일 조립*(startLaOrchestration)에서 fanout이 52s+
//    걸려도 서브틱 3회 전부 실행 + 각 broadcast가 감지 직후(≤15s 서브틱 간격) 시작.
//    ② 레거시는 broadcast-전 스냅샷을 주입받아 직전-틱 판정 유지(영구 skip 프리즈 방지).
//    ③ catch-up 실패 시 pending 재-arm(다음 무변화 틱 p10 재시도).
import type { KboRawGame } from "../../src/types/api";
import type { GameEvent } from "../../src/types/game-events";
import {
  scoreAxisSignature,
  liveCardSignature,
  seedLiveFastPathState,
  diffAndAdvance,
  runLiveFastPathTick,
  gateFastPathOnInitialBroadcast,
  startLaOrchestration,
  createLaFanoutQueue,
  type LiveFastPathDeps,
  type LegacyLastState,
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
  relay: number; android: number; snapshot: number; legacyLa: number; broadcast: number;
  catchup: number; catchupIds: string[]; iosWidget: number; events: number; score: number;
  order: string[]; legacySnapshots: Map<string, LegacyLastState>[];
  fanoutAxes: string[];
};
const SNAPSHOT_HASH = "pre-broadcast-hash";
function makeDeps(over: Partial<LiveFastPathDeps> = {}): {
  deps: LiveFastPathDeps; calls: Calls; drainFanout: () => Promise<void>;
} {
  const calls: Calls = {
    relay: 0, android: 0, snapshot: 0, legacyLa: 0, broadcast: 0, catchup: 0, catchupIds: [],
    iosWidget: 0, events: 0, score: 0, order: [], legacySnapshots: [], fanoutAxes: [],
  };
  // 느린 fanout 큐 — 테스트에서는 명시적 drain 시점까지 실행하지 않는다(서브틱 비차단 계약).
  // 삼순 R3①: android·score도 fanout 축으로 빠졌으므로 여기서 함께 큐잉·drain.
  const queued: (() => Promise<unknown>)[] = [];
  const deps: LiveFastPathDeps = {
    now: () => 1_000,
    fetchRelayLines: async () => { calls.relay++; return new Map([["20260723LGOB0", "김현수 안타"]]); },
    pushAndroid: async () => { calls.android++; calls.order.push("android"); return { sent: 1 }; },
    snapshotLegacyState: async () => {
      calls.snapshot++; calls.order.push("snapshot");
      return new Map([["20260723LGOB0", { score: "pre", hash: SNAPSHOT_HASH }]]);
    },
    enqueueFanout: (axis, _label, run) => { calls.fanoutAxes.push(axis); queued.push(run); },
    pushLegacyLa: async (_gs, _lp, snapshot) => {
      calls.legacyLa++; calls.order.push("legacyLa"); calls.legacySnapshots.push(snapshot);
      return { pushed: 1 };
    },
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
  const drainFanout = async () => {
    for (const run of queued.splice(0)) await run().catch(() => undefined);
  };
  return { deps, calls, drainFanout };
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
    check("tick: catch-up은 broadcast-only(안드/레거시/iOS/득점/스냅샷 0 — FCM dedupe 불변)",
      calls.android + calls.legacyLa + calls.broadcast + calls.iosWidget + calls.events +
        calls.score + calls.snapshot, 0);
    const r2 = await runLiveFastPathTick(deps, st, [game()], TRACE);
    check("tick: 무변화 두 번째 틱 → skipped no_diff", (r2 as { skipped?: string }).skipped, "no_diff");
    check("tick: 무변화 두 번째 틱 → 의존성 호출 추가 0(catch-up 유계 1회)",
      calls.relay + calls.android + calls.legacyLa + calls.broadcast + calls.catchup +
        calls.iosWidget + calls.events + calls.score,
      calls.catchup === 1 && calls.relay === 1 ? 2 : -1);
  }
  // catch-up 호출 실패 → pending 재-arm(다음 무변화 틱 p10 재시도 — 삼순 R2③).
  {
    let failOnce = true;
    const { deps, calls } = makeDeps({
      pushBroadcastCatchup: async () => {
        if (failOnce) { failOnce = false; throw new Error("apns down"); }
        return { updates: 1, catchups: 1 };
      },
    });
    const st = seedLiveFastPathState([game()]);
    const r1 = await runLiveFastPathTick(deps, st, [game()], TRACE);
    check("tick: catch-up 실패 → 오류 캡처",
      ((r1 as { catchup?: { result?: { error?: string } } }).catchup?.result)?.error, "apns down");
    const r2 = await runLiveFastPathTick(deps, st, [game()], TRACE);
    check("tick: catch-up 실패 후 다음 무변화 틱 재시도(재-arm)",
      (r2 as { catchup?: { gameIds?: string[] } }).catchup?.gameIds?.join(","), "20260723LGOB0");
    const r3 = await runLiveFastPathTick(deps, st, [game()], TRACE);
    check("tick: catch-up 성공 후엔 재시도 없음(유계)",
      (r3 as { catchup?: unknown }).catchup === undefined && calls.relay === 2, true);
  }
  // 삼순 R3② — catch-up 호출은 성공했지만 개별 경기 APNs transient 실패(failedGameIds) →
  // *실패 경기만* 재-arm(성공 경기는 clear 유지). updates=0이어도 stale이 안 남게.
  {
    const gA = "20260723LGOB0";
    const gB = "20260723NCSS0";
    const games2 = [game({ G_ID: gA }), game({ G_ID: gB })];
    const { deps } = makeDeps({
      pushBroadcastCatchup: async (_gs, _lp, ids) =>
        // gB만 APNs 실패로 보고(updates는 성공 1건).
        ({ updates: 1, catchups: 1, failedGameIds: ids.filter((id) => id === gB) }),
    });
    const st = seedLiveFastPathState(games2);
    const r1 = await runLiveFastPathTick(deps, st, games2, TRACE);
    check("tick R3②: catch-up 실패 경기(gB)만 재-arm 보고",
      (r1 as { catchup?: { rearmedGameIds?: string[] } }).catchup?.rearmedGameIds?.join(","), gB);
    const r2 = await runLiveFastPathTick(deps, st, games2, TRACE);
    check("tick R3②: 다음 무변화 틱은 실패 경기(gB)만 catch-up 재발송(성공 gA는 clear)",
      (r2 as { catchup?: { gameIds?: string[] } }).catchup?.gameIds?.join(","), gB);
  }
  // 삼순 R4② — 라이브 5경기×2 env APNs timeout pass가 failedGameIds 5개를 반환한
  // 상황: 한 틱에 5경기만 유계 재-arm하고, 다음 무변화 틱에서 정확히 5경기 p10
  // catch-up 1회 후 성공하면 모두 clear한다(대량 실패에서도 무한/누락 없음).
  {
    const ids = [
      "20260723LGOB0", "20260723NCSS0", "20260723KTHH0",
      "20260723SKHT0", "20260723WOLT0",
    ];
    const games5 = ids.map((id) => game({ G_ID: id }));
    let attempt = 0;
    const attemptedIds: string[][] = [];
    const { deps } = makeDeps({
      pushBroadcastCatchup: async (_gs, _lp, catchupIds) => {
        attempt += 1;
        attemptedIds.push([...catchupIds]);
        return attempt === 1
          ? { updates: 0, failedGameIds: [...catchupIds], deadlineSkipped: 2 }
          : { updates: catchupIds.length * 2, failedGameIds: [], deadlineSkipped: 0 };
      },
    });
    const st = seedLiveFastPathState(games5);
    const r1 = await runLiveFastPathTick(deps, st, games5, TRACE);
    check("tick R4②: 5경기 timeout 결과 → 5경기 전부 재-arm",
      (r1 as { catchup?: { rearmedGameIds?: string[] } }).catchup?.rearmedGameIds?.length, 5);
    const r2 = await runLiveFastPathTick(deps, st, games5, TRACE);
    check("tick R4②: 다음 무변화 틱 p10 catch-up 대상 정확히 5경기",
      (r2 as { catchup?: { gameIds?: string[] } }).catchup?.gameIds?.slice().sort().join(","),
      ids.slice().sort().join(","));
    const r3 = await runLiveFastPathTick(deps, st, games5, TRACE);
    check("tick R4②: 대량 catch-up 성공 후 모두 clear(재-arm 유계 2회)",
      (r3 as { catchup?: unknown }).catchup === undefined && attemptedIds.length === 2, true);
  }
  // 삼순 R3② — 변화 틱 broadcast 발송 중 개별 APNs 실패(failedGameIds) → 해당 경기
  // catch-up pending 재-arm(다음 무변화 틱 p10으로 수습).
  {
    const gid = "20260723LGOB0";
    const { deps, drainFanout } = makeDeps({
      pushBroadcast: async () => ({ updates: 0, failedGameIds: [gid] }),
    });
    const st = seedLiveFastPathState([game({ G_ID: gid })]);
    const r1 = await runLiveFastPathTick(deps, st, [game({ G_ID: gid, B_SCORE_CN: "1" })], TRACE);
    check("tick R3②: 변화 틱 broadcast 개별 실패 경기 보고",
      (r1 as { broadcastFailedGameIds?: string[] }).broadcastFailedGameIds?.join(","), gid);
    await drainFanout();
    // 다음 무변화 틱에서 실패 경기가 catch-up으로 수습되는지(재-arm 확인).
    const r2 = await runLiveFastPathTick(deps, st, [game({ G_ID: gid, B_SCORE_CN: "1" })], TRACE);
    check("tick R3②: broadcast 실패 경기는 다음 무변화 틱 catch-up으로 수습",
      (r2 as { catchup?: { gameIds?: string[] } }).catchup?.gameIds?.includes(gid), true);
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

  // 득점 → broadcast 크리티컬(스냅샷→broadcast) await + 느린 fanout(레거시→iOS)은 큐잉만.
  {
    const { deps, calls, drainFanout } = makeDeps();
    const st = seedLiveFastPathState([game()]);
    const r = await runLiveFastPathTick(deps, st, [game({ B_SCORE_CN: "1" })], TRACE);
    check("tick: 득점 → broadcast만 await(1회)", calls.broadcast, 1);
    check("tick: 삼순 R3① — android/score/la fanout은 틱 완료 시점에 미실행(broadcast 비차단)",
      calls.android + calls.events + calls.score + calls.legacyLa + calls.iosWidget, 0);
    check("tick: fanout 축 3계(android,score,la) 모두 enqueue",
      calls.fanoutAxes.slice().sort().join(","), "android,la,score");
    check("tick: 스냅샷은 broadcast *전*에 뜬다(레거시 직전-틱 판정 재료)",
      calls.order.filter((o) => o === "snapshot" || o === "broadcast").join(","), "snapshot,broadcast");
    check("tick: android queued 표기", (r as { android?: string }).android, "queued");
    check("tick: score queued 표기", (r as { score?: string }).score, "queued");
    check("tick: laFanout queued 표기", (r as { laFanout?: string }).laFanout, "queued");
    await drainFanout();
    check("tick: drain 후 android/score/레거시/iOS 모두 실행",
      calls.android === 1 && calls.events === 1 && calls.score === 1 &&
        calls.legacyLa === 1 && calls.iosWidget === 1, true);
    check("tick: la 축 근거 레거시→iOS 순서 실행",
      calls.order.filter((o) => o === "legacyLa" || o === "iosWidget").join(","), "legacyLa,iosWidget");
    check("tick: 레거시는 broadcast-전 스냅샷을 주입받음(영구 skip 프리즈 방지 — R2①)",
      calls.legacySnapshots[0]?.get("20260723LGOB0")?.hash, SNAPSHOT_HASH);
    check("tick: detect→send 계측 존재", (r as { detectToSendMs?: number }).detectToSendMs, 400);
  }
  // 서브틱 dedupe + 유실 재시도(삼순 R1②) — 같은 득점은 1회만 발송되되, 다음 무변화
  // 서브틱이 broadcast-only current-state catch-up을 정확히 1회 재발송(그 다음 틱은 0).
  {
    const { deps, calls, drainFanout } = makeDeps();
    const st = seedLiveFastPathState([game()]);
    await runLiveFastPathTick(deps, st, [game({ B_SCORE_CN: "1" })], TRACE);
    await drainFanout();
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
    const { deps, calls, drainFanout } = makeDeps();
    const st = seedLiveFastPathState([game()]);
    const r = await runLiveFastPathTick(deps, st, [game({ OUT_CN: 2, T_P_NM: "오스틴" })], TRACE);
    check("tick: 카드만 변화 → broadcast await 실행", calls.broadcast, 1);
    await drainFanout();
    check("tick: 카드만 변화 → android는 fanout에서 실행", calls.android, 1);
    check("tick: 카드만 변화 → 이벤트 fetch 0(원천 호출 서브틱당 1회 원칙 + score축 미enqueue)", calls.events, 0);
    check("tick: 카드만 변화 → score skipped(점수축 비변화)", ((r as { score?: unknown }).score as { skipped?: string })?.skipped, "no_score_diff");
  }
  // relay 실패 격리 — 줄만 안 뜨고 발송 경로는 그대로.
  {
    const { deps, calls, drainFanout } = makeDeps({ fetchRelayLines: async () => { throw new Error("relay down"); } });
    const st = seedLiveFastPathState([game()]);
    await runLiveFastPathTick(deps, st, [game({ B_SCORE_CN: "1" })], TRACE);
    check("tick: relay 실패에도 broadcast 실행", calls.broadcast, 1);
    await drainFanout();
    check("tick: relay 실패에도 score 실행", calls.score, 1);
  }
  // 스냅샷 실패 격리 — 빈 스냅샷 fallback(레거시 p10 과발송 쪽 안전), broadcast 그대로.
  {
    const { deps, calls, drainFanout } = makeDeps({
      snapshotLegacyState: async () => { throw new Error("db down"); },
    });
    const st = seedLiveFastPathState([game()]);
    await runLiveFastPathTick(deps, st, [game({ B_SCORE_CN: "1" })], TRACE);
    check("tick: 스냅샷 실패에도 broadcast 실행", calls.broadcast, 1);
    await drainFanout();
    check("tick: 스냅샷 실패 → 레거시에 빈 Map 주입(p10 쪽 안전 fallback)",
      calls.legacySnapshots[0]?.size, 0);
  }
  // 한 경로 오류 격리 — legacyLa 오류가 같은 fanout의 iOS 위젯을 막지 않음.
  {
    const { deps, calls, drainFanout } = makeDeps({ pushLegacyLa: async () => { throw new Error("apns down"); } });
    const st = seedLiveFastPathState([game()]);
    await runLiveFastPathTick(deps, st, [game({ B_SCORE_CN: "1" })], TRACE);
    check("tick: legacyLa 오류 격리 → broadcast 실행", calls.broadcast, 1);
    await drainFanout();
    check("tick: legacyLa 오류 격리 → score 실행", calls.score, 1);
    check("tick: legacyLa 오류 격리 → iOS 위젯은 실행(la 축 항목별 격리)", calls.iosWidget, 1);
  }
  // 이벤트 fetch 오류 → score 미실행(다음 분 cron이 claim 안 된 이벤트를 커버).
  {
    const { deps, calls, drainFanout } = makeDeps({ fetchGameEvents: async () => { throw new Error("events down"); } });
    const st = seedLiveFastPathState([game()]);
    await runLiveFastPathTick(deps, st, [game({ B_SCORE_CN: "1" })], TRACE);
    check("tick: 이벤트 fetch 오류에도 카드(broadcast) 경로 실행", calls.broadcast, 1);
    await drainFanout();
    check("tick: 이벤트 fetch 오류 → notifyScore 미호출(다음 분 cron 커버)", calls.score, 0);
  }
  // fanout 큐 — enqueue 순서 직렬 실행 + 오류 격리(뒤 항목 계속).
  {
    const q = createLaFanoutQueue();
    const ran: string[] = [];
    q.enqueue("a", async () => { ran.push("a"); return "A"; });
    q.enqueue("b", async () => { throw new Error("boom"); });
    q.enqueue("c", async () => { ran.push("c"); return "C"; });
    const drained = await q.drain();
    const results = drained.results;
    check("queue: 직렬 순서", ran.join(","), "a,c");
    check("queue: drain 완료 → timedOut=false, pending=0",
      drained.timedOut === false && drained.pendingCount === 0, true);
    check("queue: 오류 격리 + 결과 캡처",
      results.map((r) => r.label).join(",") === "a,b,c" &&
        (results[1].result as { error?: string })?.error === "boom", true);
  }

  // ── 삼순 R2 blocker①② route-조립 회귀 — startLaOrchestration(route.ts와 동일 조립)에
  // fake clock/지연 구현체 주입. 레거시/start/iOS fanout이 52s+ 미완료여도 서브틱 3회
  // 전부 실행되고, 각 broadcast가 감지 시점(+15/+30/+45s)에 즉시 시작됨을 검증.
  {
    let nowMs = 0;
    const sleep = async (ms: number) => { nowMs += ms; };
    let score = 0;
    const broadcastAt: number[] = [];
    let legacyCalls = 0;
    let startCalls = 0;
    let iosCalls = 0;
    let scorePush = 0;
    const orch = startLaOrchestration({
      now: () => nowMs,
      sleep,
      fetchLiveGames: async () => {
        score += 1; // 매 서브틱 점수 변화 → 매 틱 broadcast 기대
        return {
          ok: true,
          games: [game({ B_SCORE_CN: String(score) })],
          trace: { sourceAtMs: nowMs, fetchedAtMs: nowMs },
        };
      },
      fetchRelayLines: async () => new Map(),
      ensureChannels: async () => ({ created: 0 }),
      snapshotLegacyState: async () => new Map(),
      pushBroadcast: async () => { broadcastAt.push(nowMs); return { updates: 1 }; },
      pushBroadcastCatchup: async () => ({ updates: 1 }),
      // 느린 fanout 재현 — 영원히 미완료(>52s와 등가). 큐가 직렬이라 start/iOS도 뒤에서 대기.
      pushLegacyLa: () => { legacyCalls += 1; return new Promise(() => {}); },
      pushStarts: async () => { startCalls += 1; return { started: 0 }; },
      pushIosWidget: async () => { iosCalls += 1; return { sent: 0 }; },
      pushAndroid: async () => ({ sent: 1 }),
      fetchGameEvents: async (ids) => new Map<string, GameEvent[]>(ids.map((id) => [id, []])),
      notifyScore: async () => { scorePush += 1; return { scored: 1, conceded: 0 }; },
    }, {
      requestStartMs: 0,
      deadlineAtMs: 52_000,
      initialFetchOk: true,
      games: [game()],
      liveGameIds: ["20260723LGOB0"],
    });
    // 친리티컬 패스(relay→ensure→스냅샷→broadcast)는 설계상 수초 내 완료가 정상 — fake
    // sleep이 동기적으로 시계를 점프시키므로(실제 병렬 대기 불가) 먼저 settle만 보장.
    // 느린 쪽(fanout)은 아래서 영구 미완료로 재현된다.
    await orch.criticalPromise;
    const ticks = await orch.runFastLoop();
    check("orch: 레거시 fanout 52s+ 미완료에도 서브틱 3회 전부 실행(R2①)", ticks.length, 3);
    check("orch: broadcast = cycle0 1회 + 서브틱 3회", broadcastAt.length, 4);
    check("orch: 각 서브틱 broadcast는 감지 시점(+15/+30/+45s) 즉시 시작(≤15s SLO)",
      broadcastAt.join(","), "0,15000,30000,45000");
    check("orch: 느린 la fanout은 큐에서 1회만 시작(직렬 — 뒤 항목이 gate를 못 막음 증명)",
      legacyCalls === 1 && startCalls === 0 && iosCalls === 0, true);
    // 삼순 R3③ — la 축(cycle0 레거시)이 영구 미완료여도 drain은 deadline 유계로 잘라
    // partial 반환(504 불가). android/score 축은 이미 완료. deadline은 마지막 서브틱(+45s)
    // 이후로 두어 남은 예산 안에서 끊김을 재현.
    const drained = await orch.drainFanout({
      deadlineAtMs: 60_000, now: () => nowMs, sleep,
    });
    check("orch: 득점 푸시도 서브틱당 1회(점수축 변화 — score 축 drain 후)", scorePush, 3);
    check("orch: drain은 la 축 영구 미완료를 deadline 유계로 잘라 timedOut(504 불가 — R3③)",
      drained.timedOut === true && drained.pendingCount >= 1, true);
    check("orch: drain deadline 후 nowMs가 deadline 도달(무제한 대기 아님)", nowMs >= 60_000, true);
  }
  // ── 삼순 R3① 축 분리 회귀 — Android/득점 tail이 영구 미완료여도 서브틱 broadcast는
  // +15/+30/+45s에 즉시 실행됨을 route-동일 조립으로 검증(기존 R2 스모크는 느린 la fanout만
  // 재현해 이 배선을 못 잡았음).
  {
    let nowMs = 0;
    const sleep = async (ms: number) => { nowMs += ms; };
    let score = 0;
    const broadcastAt: number[] = [];
    let androidStarts = 0;
    let scoreStarts = 0;
    const orch = startLaOrchestration({
      now: () => nowMs,
      sleep,
      fetchLiveGames: async () => {
        score += 1;
        return {
          ok: true,
          games: [game({ B_SCORE_CN: String(score) })],
          trace: { sourceAtMs: nowMs, fetchedAtMs: nowMs },
        };
      },
      fetchRelayLines: async () => new Map(),
      ensureChannels: async () => ({ created: 0 }),
      snapshotLegacyState: async () => new Map(),
      pushBroadcast: async () => { broadcastAt.push(nowMs); return { updates: 1 }; },
      pushBroadcastCatchup: async () => ({ updates: 1 }),
      pushLegacyLa: async () => ({ pushed: 1 }),
      pushStarts: async () => ({ started: 0 }),
      pushIosWidget: async () => ({ sent: 1 }),
      // 삼순 R3① 재현 — Android 위젯 FCM tail 영구 미완료(>52s 등가).
      pushAndroid: () => { androidStarts += 1; return new Promise(() => {}); },
      fetchGameEvents: async (ids) => new Map<string, GameEvent[]>(ids.map((id) => [id, []])),
      // 삼순 R3① 재현 — 득점 푸시(fetch→notify) tail 영구 미완료.
      notifyScore: () => { scoreStarts += 1; return new Promise(() => {}); },
    }, {
      requestStartMs: 0,
      deadlineAtMs: 52_000,
      initialFetchOk: true,
      games: [game()],
      liveGameIds: ["20260723LGOB0"],
    });
    await orch.criticalPromise;
    const ticks = await orch.runFastLoop();
    check("orch R3①: Android/득점 tail 영구 미완료에도 서브틱 3회 전부 실행", ticks.length, 3);
    check("orch R3①: 각 서브틱 broadcast는 +15/+30/+45s 즉시 시작(android/score tail 비차단)",
      broadcastAt.join(","), "0,15000,30000,45000");
    // 축 큐는 직렬(canonical dedupe/발송 순서 보장) — tick1의 android/score가 영구 미완료면
    // tick2/3의 같은 축은 대기(la 축의 legacyCalls===1과 동일 tradeoff). 핵심은 이 tail이
    // *broadcast 축을 못 막는다*는 것(위 broadcastAt 4회로 증명). 각 축 1회만 시작이 정상.
    check("orch R3①: android/score 축은 직렬 — 각 1회만 시작(broadcast 비차단 tradeoff)",
      androidStarts === 1 && scoreStarts === 1, true);
  }
  // ── 삼순 R4① 실제 route 순서 회귀 ──
  // route처럼 fastPromise를 만든 직후 drain을 동시에 시작한다. seal 전 drain sleep은
  // 미완료로 두고, fast-loop의 15초 sleep만 fake clock으로 진행시켜 +15/+30/+45 틱이
  // 뒤늦게 enqueue한 모든 축 tail을 drain 결과가 회수하는지 검증한다.
  {
    let nowMs = 0;
    let score = 0;
    const never = new Promise<void>(() => {});
    const sleep = async (ms: number) => {
      if (ms > 15_000) return never;
      nowMs += ms;
    };
    const orch = startLaOrchestration({
      now: () => nowMs,
      sleep,
      fetchLiveGames: async () => {
        score += 1;
        return {
          ok: true,
          games: [game({ B_SCORE_CN: String(score) })],
          trace: { sourceAtMs: nowMs, fetchedAtMs: nowMs },
        };
      },
      fetchRelayLines: async () => new Map(),
      ensureChannels: async () => ({ created: 0 }),
      snapshotLegacyState: async () => new Map(),
      pushBroadcast: async () => ({ updates: 1 }),
      pushBroadcastCatchup: async () => ({ updates: 1 }),
      pushLegacyLa: async () => ({ pushed: 1 }),
      pushStarts: async () => ({ started: 1 }),
      pushIosWidget: async () => ({ sent: 1 }),
      pushAndroid: async () => ({ sent: 1 }),
      fetchGameEvents: async (ids) => new Map<string, GameEvent[]>(ids.map((id) => [id, []])),
      notifyScore: async () => ({ scored: 1, conceded: 0 }),
    }, {
      requestStartMs: 0,
      deadlineAtMs: 52_000,
      initialFetchOk: true,
      games: [game()],
      liveGameIds: ["20260723LGOB0"],
    });
    // route 순서: startWidgetRefreshPipelines가 fastPromise를 먼저 시작하고, 응답 회수
    // Promise.all에서 drain을 fastPromise와 함께 await한다.
    const fastPromise = orch.runFastLoop();
    const drainPromise = orch.drainFanout({
      deadlineAtMs: 68_000,
      now: () => nowMs,
      sleep,
    });
    const [ticks, drained] = await Promise.all([fastPromise, drainPromise]);
    const labels = drained.results.map((r) => r.label);
    check("orch R4①: route 동시 drain에서도 fast-loop +15/+30/+45 3틱 완료",
      ticks.length, 3);
    check("orch R4①: seal 후 drain이 뒤늦은 la tail 3건 전부 회수",
      labels.filter((label) => label.startsWith("tick:")).length >= 9, true);
    check("orch R4①: 공동 deadline 전 전체 drain 완료 → pending 0 정확 기록",
      drained.timedOut === false && drained.pendingCount === 0, true);
  }
  // 초기 broadcast 자체가 deadline까지 미완료 → 서브틱 발송 0 + initial_broadcast_overrun
  // (broadcast 축 순서 보장 = stale-overwrite 방지 유지, 시간 유계 대기 증명).
  {
    let nowMs = 0;
    const sleep = async (ms: number) => { nowMs += ms; };
    let runTickSideEffects = 0;
    const orch = startLaOrchestration({
      now: () => nowMs,
      sleep,
      fetchLiveGames: async () => ({
        ok: true,
        games: [game({ B_SCORE_CN: "9" })],
        trace: { sourceAtMs: nowMs, fetchedAtMs: nowMs },
      }),
      fetchRelayLines: async () => new Map(),
      ensureChannels: async () => ({ created: 0 }),
      snapshotLegacyState: async () => new Map(),
      pushBroadcast: () => new Promise(() => {}), // 초기 broadcast 행 — 영원히 미완료
      pushBroadcastCatchup: async () => { runTickSideEffects += 1; return {}; },
      pushLegacyLa: async () => ({ pushed: 0 }),
      pushStarts: async () => ({ started: 0 }),
      pushIosWidget: async () => { runTickSideEffects += 1; return {}; },
      pushAndroid: async () => { runTickSideEffects += 1; return {}; },
      fetchGameEvents: async () => new Map(),
      notifyScore: async () => { runTickSideEffects += 1; return {}; },
    }, {
      requestStartMs: 0,
      deadlineAtMs: 52_000,
      initialFetchOk: true,
      games: [game()],
      liveGameIds: ["20260723LGOB0"],
    });
    const ticks = await orch.runFastLoop();
    check("orch: 초기 broadcast 미완료 → 서브틱 발송 0(stale-overwrite 방지 유지)",
      runTickSideEffects, 0);
    check("orch: 초기 broadcast 미완료 → initial_broadcast_overrun 기록",
      (ticks[0]?.result as { skipped?: string })?.skipped, "initial_broadcast_overrun");
  }
  // 게이트 단독 — 이미 열린 뒤에는 즉시 통과(재검사 오버헤드 없음).
  {
    let nowMs = 0;
    let ran = 0;
    const gated = gateFastPathOnInitialBroadcast({
      initialBroadcastDone: Promise.resolve(),
      deadlineAtMs: 52_000,
      now: () => nowMs,
      sleep: async (ms) => { nowMs += ms; },
      runTick: async () => { ran += 1; return { ok: true }; },
    });
    await gated([game()], TRACE);
    nowMs = 30_000;
    await gated([game()], TRACE);
    check("gate: settled promise → 즉시 통과 2회", ran, 2);
    nowMs = 60_000;
    const r = await gated([game()], TRACE);
    check("gate: deadline 경과 후엔 발송 금지", (r as { skipped?: string }).skipped, "initial_broadcast_overrun");
  }

  console.log(`\nlive-fast-path smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(1);
});
