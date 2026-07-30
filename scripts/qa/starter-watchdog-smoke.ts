/**
 * 예고선발 공개 watchdog 오케스트레이터 회귀 — 실제 runStarterWatchdog 를 주입 fake 로 구동.
 * 삼순 조건부 GO + NO-GO 재작업 계약: 실제 빈값→공식값 전이 1회 발송 · rollout 기공개 baseline 미발송 ·
 * 종결 state 완전 skip · definitive KBO 소스(Naver fallback 금지) · 한쪽만 공개 미발송 · 더블헤더 경기별 ·
 * 취소 억제 · 재수집(2-tick) 중복 0 · 다중 날짜(연전 공시) · systemic 실패 노출 · due drainer.
 * 실행: npm run qa:starter-watchdog
 */
import "./_smoke-env"; // supabase/admin 싱글톤이 모듈 로드 시 env 요구 → 더미 선주입(fake 주입이라 실 호출 없음)
import { runStarterWatchdog, type StarterWatchdogDeps } from "../../src/lib/notifications/starter-watchdog";
import type { KboGame } from "../../src/lib/crawler/kbo-api";
import type { StarterDeliveryResult, StarterObserveAction, DueStarterSnapshot } from "../../src/lib/notifications/starter-announce-delivery";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}`); }
}

function game(
  gameId: string,
  status: KboGame["status"],
  home: number,
  away: number,
  starters: { away?: string; home?: string } = {},
  time = "18:30",
): KboGame {
  return {
    gameId, date: gameId.slice(0, 8), time, stadium: "", awayTeamId: away, homeTeamId: home,
    awayName: "", homeName: "", awayScore: null, homeScore: null, inning: 0, isTop: true, status,
    awayStarterName: starters.away ?? "", homeStarterName: starters.home ?? "",
    winPitcher: "", losePitcher: "", savePitcher: "",
    strikes: 0, balls: 0, outs: 0, runnersOn: { first: false, second: false, third: false },
    currentPitcher: "", currentBatter: "", awayRank: 0, homeRank: 0,
  };
}
function batch(over: Partial<{ claimed: number; pending: number; snapshotCompleted: boolean; fcmAcceptedDelta: number; permanentFailed: number; expired: number }> = {}) {
  return {
    claimed: over.claimed ?? 1, pending: over.pending ?? 0,
    snapshotCompleted: over.snapshotCompleted ?? true, fcmAcceptedDelta: over.fcmAcceptedDelta ?? 1,
    fcmAcceptedTotal: 1, permanentFailed: over.permanentFailed ?? 0, expired: over.expired ?? 0,
  };
}
function fin(over: Partial<StarterDeliveryResult> = {}): StarterDeliveryResult {
  return {
    snapshotCompleted: over.snapshotCompleted ?? false, fcmAcceptedDelta: over.fcmAcceptedDelta ?? 0,
    fcmAcceptedTotal: over.fcmAcceptedTotal ?? 0, pending: over.pending ?? 0,
    permanentFailed: over.permanentFailed ?? 0, expired: over.expired ?? 0,
  };
}
function base(over: Partial<StarterWatchdogDeps> = {}): Partial<StarterWatchdogDeps> {
  return {
    // 기본 fake 관측: 공식값 경기는 이미 빈값 관측 이력이 있는 '실제 전이'로 취급(emit).
    // baseline/전이 시나리오는 개별 테스트가 stateful fake 로 덮어쓴다.
    observeGames: async (obs) =>
      new Map(obs.filter((o) => o.bothOfficial).map((o) => [o.gameId, "emit" as StarterObserveAction])),
    finalizeSnapshot: async () => fin(),
    listDueSnapshots: async () => [],
    now: () => Date.now(),
    ...over,
  };
}

/** 실제 observe RPC 와 동일한 의미론의 stateful in-memory fake (전이/baseline 회귀용). */
function statefulObserve() {
  const seen = new Map<string, { sawUnannounced: boolean }>();
  return async (obs: Array<{ gameId: string; bothOfficial: boolean }>) => {
    const out = new Map<string, StarterObserveAction>();
    for (const o of obs) {
      const st = seen.get(o.gameId) ?? { sawUnannounced: false };
      if (!o.bothOfficial) st.sawUnannounced = true;
      seen.set(o.gameId, st);
      out.set(o.gameId, o.bothOfficial ? (st.sawUnannounced ? "emit" : "baseline") : "wait");
    }
    return out;
  };
}
const BOTH = { away: "김윤식", home: "폰세" };

async function main() {
  // ── 양팀 공식값 전이 → 홈/원정 2 대상 open+drain, 1회 발송 ──
  {
    const opened = new Set<string>();
    const drained = new Set<string>();
    const r = await runStarterWatchdog({
      dateStrs: ["20260730"], deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 9, 1, BOTH)],
        openSnapshot: async (t) => { opened.add(`${t.gameId}:${t.teamId}`); return Date.now() + 60_000; },
        deliverBatch: async (t) => { drained.add(`${t.gameId}:${t.teamId}`); return batch(); },
      }),
    });
    ok("양팀 공식값 → 홈(9)/원정(1) 2 대상 open", opened.has("G1:9") && opened.has("G1:1") && r.summary.snapshotsOpened === 2);
    ok("2 대상 전부 drain·status ok", drained.size === 2 && r.status === "ok" && r.summary.accepted === 2);
    ok("announced/targets 집계", r.summary.announced === 1 && r.summary.targets === 2);
  }

  // ── 한쪽만 공개 → 미발송(양팀 확정 대기, ok) ──
  {
    let opens = 0;
    const r = await runStarterWatchdog({
      dateStrs: ["20260730"], deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [
          game("G1", "scheduled", 9, 1, { home: "폰세" }), // 홈만 공개
          game("G2", "scheduled", 3, 5, { away: "쿠에바스" }), // 원정만 공개
        ],
        openSnapshot: async () => { opens++; return Date.now() + 60_000; },
        deliverBatch: async () => batch(),
      }),
    });
    ok("한쪽만 공개 → open 0(미발송)", opens === 0 && r.summary.announced === 0 && r.summary.targets === 0);
    ok("한쪽만 공개는 건강한 대기 → status ok", r.status === "ok");
  }

  // ── 더블헤더: gameId 상이(…0/…1) → 경기별 각각 대상 ──
  {
    const opened = new Set<string>();
    const r = await runStarterWatchdog({
      dateStrs: ["20260730"], deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [
          game("20260730LGHH0", "scheduled", 9, 1, BOTH),
          game("20260730LGHH1", "scheduled", 9, 1, { away: "이민호", home: "문동주" }),
        ],
        openSnapshot: async (t) => { opened.add(`${t.gameId}:${t.teamId}`); return Date.now() + 60_000; },
        deliverBatch: async () => batch(),
      }),
    });
    ok("더블헤더 → 경기별 각 2 대상(총 4)", opened.size === 4 && r.summary.announced === 2 && r.summary.targets === 4);
  }

  // ── 취소/live/final 억제: scheduled 만 신규 대상 ──
  {
    const opened = new Set<string>();
    const r = await runStarterWatchdog({
      dateStrs: ["20260730"], deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [
          game("A", "scheduled", 1, 2, BOTH),
          game("B", "cancelled", 3, 4, BOTH), // 취소 — 선발 공식값이어도 미발송
          game("C", "live", 5, 6, BOTH),
          game("D", "final", 7, 8, BOTH),
        ],
        openSnapshot: async (t) => { opened.add(`${t.gameId}:${t.teamId}`); return Date.now() + 60_000; },
        deliverBatch: async () => batch(),
      }),
    });
    ok("취소 경기 미발송 억제(scheduled A 만)", opened.size === 2 && opened.has("A:1") && opened.has("A:2"));
    ok("scheduled 집계 1", r.summary.scheduled === 1 && r.status === "ok");
  }

  // ── 재수집 2-tick: 이미 발송된 (game,team)은 원장이 재발송 차단(중복 0) ──
  //    tick2 의 openSnapshot 멱등(신규 행 0) + claim 0 을 fake 로 재현 — 실제 계약은 DB 통합 테스트가 고정.
  {
    const sent: string[] = [];
    const notified = new Set<string>();
    const deps = (): Partial<StarterWatchdogDeps> => base({
      fetchGames: async () => [game("G1", "scheduled", 9, 1, BOTH)],
      openSnapshot: async () => Date.now() + 60_000, // 멱등: 존재 시 기존 deadline 반환(행 추가 없음)
      deliverBatch: async (t) => {
        const k = `${t.gameId}:${t.teamId}`;
        if (notified.has(k)) return batch({ claimed: 0, pending: 0, snapshotCompleted: false, fcmAcceptedDelta: 0 });
        notified.add(k);
        sent.push(k);
        return batch();
      },
    });
    const t1 = await runStarterWatchdog({ dateStrs: ["20260730"], deadlineAtMs: Date.now() + 16_000, deps: deps() });
    const t2 = await runStarterWatchdog({ dateStrs: ["20260730"], deadlineAtMs: Date.now() + 16_000, deps: deps() });
    ok("tick1 발송 2(홈/원정)", sent.length === 2 && t1.status === "ok");
    ok("tick2 재수집 → 신규 발송 0(중복 0)", sent.length === 2 && t2.summary.accepted === 0 && t2.status === "ok");
  }

  // ── 다중 날짜(연전 공시): D+1 경기 선발도 감지 ──
  {
    const opened = new Set<string>();
    const fetched: string[] = [];
    const r = await runStarterWatchdog({
      dateStrs: ["20260730", "20260731", "20260801"], deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async (d) => {
          fetched.push(d);
          if (d === "20260731") return [game("20260731LGHH0", "scheduled", 9, 1, BOTH)];
          return [];
        },
        openSnapshot: async (t) => { opened.add(`${t.gameId}:${t.teamId}`); return Date.now() + 60_000; },
        deliverBatch: async () => batch(),
      }),
    });
    ok("3일치 fetch", fetched.length === 3 && r.summary.dates === 3);
    ok("D+1 경기 선발 공시 감지 → 2 대상", opened.size === 2 && r.status === "ok");
  }

  // ── 부분 fetch 실패 → failed(systemic), 다른 날짜는 계속(격리) ──
  {
    const opened = new Set<string>();
    const r = await runStarterWatchdog({
      dateStrs: ["20260730", "20260731"], deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async (d) => {
          if (d === "20260730") throw new Error("kbo down");
          return [game("20260731LGHH0", "scheduled", 9, 1, BOTH)];
        },
        openSnapshot: async (t) => { opened.add(`${t.gameId}:${t.teamId}`); return Date.now() + 60_000; },
        deliverBatch: async () => batch(),
      }),
    });
    ok("부분 fetch 실패 → failed", r.status === "failed" && r.summary.fetchFailures === 1);
    ok("다른 날짜는 계속 발송(격리)", opened.size === 2);
  }

  // ── drainError → failed + 격리(뒤 대상 완주) ──
  {
    const drained = new Set<string>();
    const r = await runStarterWatchdog({
      dateStrs: ["20260730"], deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 9, 1, BOTH), game("G2", "scheduled", 3, 5, BOTH)],
        openSnapshot: async () => Date.now() + 60_000,
        deliverBatch: async (t) => {
          const key = `${t.gameId}:${t.teamId}`;
          if (key === "G1:9") throw new Error("rpc abort");
          drained.add(key);
          return batch();
        },
      }),
    });
    ok("한 대상 drain 실패에도 나머지 3 대상 drain(격리)", drained.size === 3);
    ok("drainError → failed", r.summary.drainErrors === 1 && r.status === "failed");
  }

  // ── partial open 실패 → failed ──
  {
    const r = await runStarterWatchdog({
      dateStrs: ["20260730"], deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 9, 1, BOTH)],
        openSnapshot: async (t) => {
          if (t.teamId === 9) return Date.now() + 60_000;
          throw new Error("db down");
        },
        deliverBatch: async () => batch(),
      }),
    });
    ok("open 부분 실패 → failed", r.status === "failed" && r.summary.snapshotOpenErrors === 1 && r.summary.snapshotsOpened === 1);
  }

  // ── expired>0 → failed(마감 내 미발송 경보) ──
  {
    const r = await runStarterWatchdog({
      dateStrs: ["20260730"], deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 9, 1, BOTH)],
        openSnapshot: async () => Date.now() + 60_000,
        deliverBatch: async () => batch({ claimed: 0, pending: 0 }),
        finalizeSnapshot: async () => fin({ expired: 3 }),
      }),
    });
    ok("expired>0 → failed", r.summary.expired === 6 && r.status === "failed"); // 홈/원정 각 3
  }

  // ── FCM transient pending>0 → failed ──
  {
    const r = await runStarterWatchdog({
      dateStrs: ["20260730"], deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 9, 1, BOTH)],
        openSnapshot: async () => Date.now() + 60_000,
        deliverBatch: async () => batch({ claimed: 1, pending: 1, snapshotCompleted: false, fcmAcceptedDelta: 0 }),
        finalizeSnapshot: async () => fin({ pending: 2 }),
      }),
    });
    ok("FCM transient pending>0 → failed", r.status === "failed" && r.summary.pending > 0);
  }

  // ── all-permanent → failed ──
  {
    const r = await runStarterWatchdog({
      dateStrs: ["20260730"], deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 9, 1, BOTH)],
        openSnapshot: async () => Date.now() + 60_000,
        deliverBatch: async () => batch({ claimed: 2, pending: 0, snapshotCompleted: true, fcmAcceptedDelta: 0, permanentFailed: 2 }),
        finalizeSnapshot: async () => fin({ snapshotCompleted: true, pending: 0, permanentFailed: 2 }),
      }),
    });
    ok("all-permanent → failed", r.status === "failed" && r.summary.permanentFailed > 0 && r.summary.accepted === 0);
  }

  // ── batch counters 보존: informative → reserve-skip → finalize throw → failed(counters 유지) ──
  {
    const calls: Record<string, number> = {};
    const r = await runStarterWatchdog({
      dateStrs: ["20260730"], deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 9, 1, BOTH)],
        openSnapshot: async () => Date.now() + 60_000,
        deliverBatch: async (t) => {
          const k = `${t.gameId}:${t.teamId}`;
          calls[k] = (calls[k] ?? 0) + 1;
          if (calls[k] === 1) return batch({ claimed: 1, pending: 1, snapshotCompleted: false, fcmAcceptedDelta: 0, permanentFailed: 2 });
          return { claimed: 0, pending: 0, permanentFailed: 0, expired: 0, snapshotCompleted: false, fcmAcceptedDelta: 0, fcmAcceptedTotal: 0, budgetSkipped: true };
        },
        finalizeSnapshot: async () => { throw new Error("finalize RPC transient"); },
      }),
    });
    ok("reserve-skip 이 informative counters 를 덮지 않음", r.summary.pending >= 2 && r.summary.permanentFailed >= 4);
    ok("reserve-skip + finalize throw → failed", r.status === "failed");
  }

  // ── open 직후 deadline → openUnresolved → failed ──
  {
    let clock = 2_000_000;
    const DEADLINE = 2_000_000 + 16_000;
    let drains = 0;
    const r = await runStarterWatchdog({
      dateStrs: ["20260730"], deadlineAtMs: DEADLINE,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 9, 1, BOTH)],
        openSnapshot: async () => { clock = DEADLINE; return DEADLINE + 60_000; },
        deliverBatch: async () => { drains++; return batch(); },
        finalizeSnapshot: async () => { throw new Error("finalize skipped at deadline"); },
        now: () => clock,
      }),
    });
    ok("open 직후 deadline → batch 0회·openUnresolved·failed", drains === 0 && r.summary.openUnresolved > 0 && r.status === "failed");
  }

  // ── due-ledger drainer 2-tick: tick1 실패분을 tick2 가 (경기 상태 무관) 이어 drain ──
  {
    const t1 = await runStarterWatchdog({
      dateStrs: ["20260730"], deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 9, 1, BOTH)],
        openSnapshot: async () => Date.now() + 30 * 60_000,
        deliverBatch: async (t) => {
          if (t.teamId === 9) throw new Error("db timeout");
          return batch();
        },
      }),
    });
    ok("tick1: team9 drain 실패 → failed", t1.status === "failed" && t1.summary.drainErrors === 1);

    const dueDelivered = new Set<string>();
    const due: DueStarterSnapshot[] = [
      { gameId: "G1", teamId: 9, snapshotDeadlineAtMs: Date.now() + 20 * 60_000, payload: { title: "한화 예고선발 공개", body: "…", url: "/games/G1" } },
    ];
    const t2 = await runStarterWatchdog({
      dateStrs: ["20260730"], deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "live", 9, 1, BOTH)], // 그 사이 live 전환
        openSnapshot: async () => { throw new Error("must not open for live"); },
        deliverBatch: async (t) => { dueDelivered.add(`${t.gameId}:${t.teamId}`); return batch(); },
        listDueSnapshots: async () => due,
      }),
    });
    ok("tick2: live 전환에도 due 원장 이어 drain", dueDelivered.has("G1:9") && t2.summary.dueDrained === 1 && t2.status === "ok");
  }

  // ── due 가 fresh 와 중복이면 skip(이번 tick freshKeys) ──
  {
    const delivered: string[] = [];
    const r = await runStarterWatchdog({
      dateStrs: ["20260730"], deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 9, 1, BOTH)],
        openSnapshot: async () => Date.now() + 30 * 60_000,
        deliverBatch: async (t) => { delivered.push(`${t.gameId}:${t.teamId}`); return batch(); },
        listDueSnapshots: async () => [
          { gameId: "G1", teamId: 9, snapshotDeadlineAtMs: Date.now() + 60_000, payload: { title: "", body: "", url: "" } },
        ],
      }),
    });
    ok("fresh 처리한 (G1,9) due skip(중복 drain 0)", delivered.filter((k) => k === "G1:9").length === 1 && r.summary.dueDrained === 0);
  }

  // ── due 조회 실패 → failed ──
  {
    const r = await runStarterWatchdog({
      dateStrs: ["20260730"], deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [],
        listDueSnapshots: async () => { throw new Error("due query down"); },
      }),
    });
    ok("due 조회 실패 → drainError·failed", r.summary.drainErrors === 1 && r.status === "failed");
  }

  // ── 경기 0/선발 미공개 → ok ──
  {
    const r = await runStarterWatchdog({
      dateStrs: ["20260730"], deadlineAtMs: Date.now() + 16_000,
      deps: base({ fetchGames: async () => [] }),
    });
    ok("경기 0 → ok", r.status === "ok" && r.summary.scheduled === 0);
  }

  // ── deadline 즉시 → open/drain 0 ──
  {
    let opens = 0, drains = 0;
    await runStarterWatchdog({
      dateStrs: ["20260730"], deadlineAtMs: 1_000_000,
      deps: base({
        fetchGames: async () => [game("A", "scheduled", 1, 2, BOTH)],
        openSnapshot: async () => { opens++; return 1_000_000 + 60_000; },
        deliverBatch: async () => { drains++; return batch(); },
        now: () => 1_000_000,
      }),
    });
    ok("deadline 즉시 → open/drain 0", opens === 0 && drains === 0);
  }

  // ── [NO-GO 재작업 2] rollout 첫 tick: 이미 공식값(빈값 관측 이력 없음) → baseline 기록만, 발송 0 ──
  {
    let opens = 0;
    const observe = statefulObserve();
    const r = await runStarterWatchdog({
      dateStrs: ["20260730"], deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 9, 1, BOTH), game("G2", "scheduled", 3, 5, BOTH)],
        observeGames: observe,
        openSnapshot: async () => { opens++; return Date.now() + 60_000; },
        deliverBatch: async () => batch(),
      }),
    });
    ok("배포 첫 tick 기공개 → baseline 기록만·발송 0(stale burst 차단)", opens === 0 && r.summary.baselines === 2 && r.summary.transitions === 0 && r.summary.targets === 0);
    ok("baseline-only tick 은 건강한 상태 → status ok", r.status === "ok");

    // 같은 경기가 다음 tick 에도 공식값이면 여전히 baseline(빈값 관측 없이 emit 으로 승격 금지).
    const r2 = await runStarterWatchdog({
      dateStrs: ["20260730"], deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 9, 1, BOTH), game("G2", "scheduled", 3, 5, BOTH)],
        observeGames: observe,
        openSnapshot: async () => { opens++; return Date.now() + 60_000; },
        deliverBatch: async () => batch(),
      }),
    });
    ok("후속 tick 에도 baseline 유지 → 발송 0", opens === 0 && r2.summary.baselines === 2 && r2.summary.transitions === 0);
  }

  // ── [NO-GO 재작업 2] 실제 빈값→공식값 전이: tick1 빈값 관측 → tick2 공식값 → 1회 발송 ──
  {
    const opened = new Set<string>();
    const observe = statefulObserve();
    const mk = (starters: { away?: string; home?: string }) => base({
      fetchGames: async () => [game("G1", "scheduled", 9, 1, starters)],
      observeGames: observe,
      openSnapshot: async (t) => { opened.add(`${t.gameId}:${t.teamId}`); return Date.now() + 60_000; },
      deliverBatch: async () => batch(),
    });
    const t1 = await runStarterWatchdog({ dateStrs: ["20260730"], deadlineAtMs: Date.now() + 16_000, deps: mk({}) });
    ok("tick1 빈값 관측 → wait·발송 0", opened.size === 0 && t1.summary.announced === 0 && t1.status === "ok");
    const t2 = await runStarterWatchdog({ dateStrs: ["20260730"], deadlineAtMs: Date.now() + 16_000, deps: mk(BOTH) });
    ok("tick2 공식값 → 실제 전이로 홈/원정 발송", opened.has("G1:9") && opened.has("G1:1") && t2.summary.transitions === 1 && t2.summary.baselines === 0 && t2.status === "ok");
  }

  // ── [NO-GO 재작업 3] 종결된 (game,team): snapshot RPC null → drain/finalize 없이 완전 skip ──
  //    과거 tick 에 permanent/expired 로 종결된 state 여도 재집계 0 → 반복 502 없음(ok).
  {
    let drains = 0;
    const r = await runStarterWatchdog({
      dateStrs: ["20260730"], deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 9, 1, BOTH)],
        openSnapshot: async () => null, // 이미 종결(starter_notified=true) — RPC null 계약
        deliverBatch: async () => { drains++; return batch(); },
        finalizeSnapshot: async () => { throw new Error("finalize must not run for completed state"); },
      }),
    });
    ok("종결 state → drain/finalize 0·completedSkipped 2", drains === 0 && r.summary.completedSkipped === 2 && r.summary.snapshotsOpened === 0);
    ok("종결 state 재관측은 과거 terminal 재집계 0 → status ok(반복 502 없음)", r.status === "ok" && r.summary.permanentFailed === 0 && r.summary.expired === 0 && r.summary.pending === 0);
  }

  // ── 관측 원장 RPC 실패 → 전이 판정 보류 + systemic failed(발송 안 함) ──
  {
    let opens = 0;
    const r = await runStarterWatchdog({
      dateStrs: ["20260730"], deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 9, 1, BOTH)],
        observeGames: async () => { throw new Error("observe rpc down"); },
        openSnapshot: async () => { opens++; return Date.now() + 60_000; },
        deliverBatch: async () => batch(),
      }),
    });
    ok("observe 실패 → 발송 보류·failed", opens === 0 && r.summary.observeErrors === 1 && r.status === "failed");
  }

  // ── [NO-GO 재작업 1] 실 wiring: 기본 fetch 는 definitive KBO 단독 — KBO 실패 시 Naver 로 가리지 않고 failed ──
  //    (fetchGames 의 Naver fallback 은 선발명을 항상 빈값으로 만들어 장애를 'ok/미공개'로 오인시킴)
  {
    const realFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      requested.push(url);
      if (url.includes("koreabaseball.com")) {
        return new Response("kbo down", { status: 503, statusText: "Service Unavailable" });
      }
      // Naver 가 '경기 있음·선발 빈값' 으로 응답 가능한 상황 — definitive wiring 이면 애초에 호출되면 안 된다.
      return new Response(JSON.stringify({ result: { games: [] } }), { status: 200 });
    }) as typeof fetch;
    try {
      let opens = 0;
      const r = await runStarterWatchdog({
        dateStrs: ["20260730"], deadlineAtMs: Date.now() + 16_000,
        deps: base({
          // fetchGames 미주입 → 모듈 기본값(실 wiring) 사용
          openSnapshot: async () => { opens++; return Date.now() + 60_000; },
          deliverBatch: async () => batch(),
        }),
      });
      ok("KBO 실패(+Naver 가용) → fetchFailures·failed(장애 노출, 전이 판정 보류)", r.status === "failed" && r.summary.fetchFailures === 1 && opens === 0);
      ok("definitive wiring: KBO 호출만, Naver fallback 미참조", requested.some((u) => u.includes("koreabaseball.com")) && !requested.some((u) => u.includes("naver")));
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log(`\nstarter-watchdog 오케스트레이터: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
