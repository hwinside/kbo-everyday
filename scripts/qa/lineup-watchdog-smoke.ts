/**
 * 라인업 확정 watchdog 오케스트레이터 회귀 (삼순 #952 NO-GO 1·2·3차) — 실제 runLineupWatchdog 를
 * 주입 fake 로 구동. 융합 probe(공유 barrier 제거) · all-null/partial-null→failed ·
 * drainError/expired→failed · 격리 병렬 · due-ledger drainer(2-tick) · scheduled-only · deadline.
 * 실행: npm run qa:lineup-watchdog
 */
import "./_smoke-env"; // supabase/admin 싱글톤이 모듈 로드 시 env 요구 → 더미 선주입(fake 주입이라 실 호출 없음)
import { runLineupWatchdog, type LineupWatchdogDeps } from "../../src/lib/notifications/lineup-watchdog";
import type { KboGame } from "../../src/lib/crawler/kbo-api";
import type { LineupDeliveryResult, DueLineupSnapshot } from "../../src/lib/notifications/lineup-confirm-delivery";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}`); }
}

function game(gameId: string, status: KboGame["status"], home: number, away: number, time = "18:30"): KboGame {
  return {
    gameId, date: gameId.slice(0, 8), time, stadium: "", awayTeamId: away, homeTeamId: home,
    awayName: "", homeName: "", awayScore: null, homeScore: null, inning: 0, isTop: true, status,
    awayStarterName: "", homeStarterName: "", winPitcher: "", losePitcher: "", savePitcher: "",
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
function fin(over: Partial<LineupDeliveryResult> = {}): LineupDeliveryResult {
  return {
    snapshotCompleted: over.snapshotCompleted ?? false, fcmAcceptedDelta: over.fcmAcceptedDelta ?? 0,
    fcmAcceptedTotal: over.fcmAcceptedTotal ?? 0, pending: over.pending ?? 0,
    permanentFailed: over.permanentFailed ?? 0, expired: over.expired ?? 0,
  };
}
// 실 supabase 호출 방지 기본 fake: finalize/ listDue 는 no-op(=열화 없음). 각 테스트가 필요 시 override.
function base(over: Partial<LineupWatchdogDeps> = {}): Partial<LineupWatchdogDeps> {
  return {
    finalizeSnapshot: async () => fin(),
    listDueSnapshots: async () => [],
    now: () => Date.now(),
    ...over,
  };
}
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ── 확정 2경기 → 4 대상 전부 open+drain (격리 병렬) ──
  {
    const opened = new Set<string>();
    const drained = new Set<string>();
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 1, 10), game("G2", "scheduled", 3, 5)],
        fetchLineupConfirmed: async () => true,
        openSnapshot: async (t) => { opened.add(`${t.gameId}:${t.teamId}`); return Date.now() + 60_000; },
        deliverBatch: async (t) => { drained.add(`${t.gameId}:${t.teamId}`); return batch(); },
      }),
    });
    ok("확정 2경기 → 4 대상 open", opened.size === 4 && r.summary.snapshotsOpened === 4);
    ok("4 대상 전부 drain", drained.size === 4);
    ok("status ok", r.status === "ok" && r.summary.accepted === 4);
  }

  // ── (re-gate ①) 융합 probe: G1 즉시 true, G2 느린 null, 예산 짧음 → G1 은 barrier 없이 즉시 open ──
  {
    const opened = new Set<string>();
    const start = Date.now();
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: start + 40, // 40ms absolute budget
      lineupFetchMs: 3_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 1, 10), game("G2", "scheduled", 3, 5)],
        fetchLineupConfirmed: async (id) => (id === "G1" ? true : (await later(50), null)), // G2 는 예산 뒤 null
        openSnapshot: async (t) => { opened.add(`${t.gameId}:${t.teamId}`); return Date.now() + 60_000; },
        deliverBatch: async () => batch(),
        now: () => Date.now(),
      }),
    });
    ok("느린 G2 가 G1 발송을 안 막음(G1 2대상 open)", opened.has("G1:1") && opened.has("G1:10") && r.summary.snapshotsOpened === 2);
    ok("G2 null(예산 초과) → probeFailures>0 → failed", r.summary.probeFailures >= 1 && r.status === "failed");
  }

  // ── (re-gate ②) partial null: 1 true + 1 null → failed (특정 game 열화가 가려지지 않음) ──
  {
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 1, 2), game("G2", "scheduled", 3, 4)],
        fetchLineupConfirmed: async (id) => (id === "G1" ? true : null),
        openSnapshot: async () => Date.now() + 60_000, deliverBatch: async () => batch(),
      }),
    });
    ok("1 true + 1 null → failed(부분 소스 열화)", r.status === "failed" && r.summary.probeFailures === 1);
    ok("그래도 G1 은 open+drain(격리)", r.summary.confirmed === 1 && r.summary.snapshotsOpened === 2);
  }

  // ── all-null probe → failed (엔드포인트 열화, 정상 미확정과 구분) ──
  {
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 1, 2), game("G2", "scheduled", 3, 4)],
        fetchLineupConfirmed: async () => null,
        openSnapshot: async () => Date.now() + 60_000, deliverBatch: async () => batch(),
      }),
    });
    ok("all-null probe → status failed(502)", r.status === "failed");
    ok("all-null → lineupSignals 0", r.summary.lineupSignals === 0);
  }
  // ── all-throw probe → failed ──
  {
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 1, 2)],
        fetchLineupConfirmed: async () => { throw new Error("kbo lineup down"); },
        openSnapshot: async () => Date.now() + 60_000, deliverBatch: async () => batch(),
      }),
    });
    ok("all-throw probe → status failed", r.status === "failed");
  }

  // ── 건강한 미확정(all-false) → ok, 대상 0 ──
  {
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 1, 2), game("G2", "scheduled", 3, 4)],
        fetchLineupConfirmed: async () => false,
        openSnapshot: async () => Date.now() + 60_000, deliverBatch: async () => batch(),
      }),
    });
    ok("건강한 미확정(false) → status ok", r.status === "ok");
    ok("미확정 → 대상 0, signals 2, probeFailures 0", r.summary.targets === 0 && r.summary.lineupSignals === 2 && r.summary.probeFailures === 0);
  }

  // ── (re-gate ②) drainError → failed (숨겨지지 않음) + 격리(뒤 대상 완주) ──
  {
    const drained = new Set<string>();
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 1, 10), game("G2", "scheduled", 3, 5), game("G3", "scheduled", 6, 7)],
        fetchLineupConfirmed: async () => true,
        openSnapshot: async () => Date.now() + 60_000,
        deliverBatch: async (t) => {
          const key = `${t.gameId}:${t.teamId}`;
          if (key === "G1:1") { await later(20); throw new Error("rpc abort (deadline)"); }
          drained.add(key);
          return batch();
        },
      }),
    });
    ok("첫 대상 drain hang 이어도 뒤 5 대상 전부 drain(격리)", drained.size === 5);
    ok("drainError → failed(더 이상 status ok 아님)", r.summary.drainErrors === 1 && r.status === "failed");
  }

  // ── (re-gate ②) partial open 실패(4 대상 중 3 snapshot RPC 실패) → failed ──
  {
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 1, 10), game("G2", "scheduled", 3, 5)],
        fetchLineupConfirmed: async () => true,
        openSnapshot: async (t) => {
          if (`${t.gameId}:${t.teamId}` === "G1:1") return Date.now() + 60_000;
          throw new Error("db down");
        },
        deliverBatch: async () => batch(),
      }),
    });
    ok("4 대상 중 3 open 실패 → failed", r.status === "failed");
    ok("open 성공 1·실패 3 집계", r.summary.snapshotsOpened === 1 && r.summary.snapshotOpenErrors === 3);
  }

  // ── (re-gate ②) expired → failed (마감 내 미발송 = 실제 놓침, 경보) ──
  {
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 1, 2)],
        fetchLineupConfirmed: async () => true,
        openSnapshot: async () => Date.now() + 60_000,
        deliverBatch: async () => batch({ claimed: 0, pending: 0 }), // 보낼 것 없음(deadline_at>now 필터로 claim 0)
        finalizeSnapshot: async () => fin({ expired: 3 }), // 마감 초과 만료 3
      }),
    });
    ok("expired>0 → status failed(경보)", r.summary.expired === 6 && r.status === "failed"); // G1 home+away 각 3
  }

  // ── (re-gate ③) due-ledger drainer 2-tick: tick1 team1 drain 실패, tick2 game live 여도 due 원장 이어 drain ──
  {
    // tick1: G1 scheduled, 확정. home(1) drain throw → drainError·failed. away(10) 완료.
    const t1 = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 1, 10)],
        fetchLineupConfirmed: async () => true,
        openSnapshot: async () => Date.now() + 30 * 60_000,
        deliverBatch: async (t) => {
          if (t.teamId === 1) throw new Error("db timeout");
          return batch();
        },
      }),
    });
    ok("tick1: team1 drain 실패 → failed", t1.status === "failed" && t1.summary.drainErrors === 1);

    // tick2: G1 이 live 로 전환(scheduled 필터 제외 → 신규 target 0). 하지만 due 원장(team1)이 남아 이어 drain.
    const dueDelivered = new Set<string>();
    const due: DueLineupSnapshot[] = [
      { gameId: "G1", teamId: 1, snapshotDeadlineAtMs: Date.now() + 20 * 60_000, payload: { title: "LG 라인업 확정", body: "…", url: "/games/G1?tab=lineup" } },
    ];
    const t2 = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "live", 1, 10)],
        fetchLineupConfirmed: async () => true,
        openSnapshot: async () => { throw new Error("must not open for live"); },
        deliverBatch: async (t) => { dueDelivered.add(`${t.gameId}:${t.teamId}`); return batch(); },
        listDueSnapshots: async () => due,
      }),
    });
    ok("tick2: live 여도 due 원장 team1 이어 drain", dueDelivered.has("G1:1") && t2.summary.dueDrained === 1);
    ok("tick2: 신규 open 0(live 는 신규 대상 아님)", t2.summary.snapshotsOpened === 0 && t2.summary.confirmed === 0);
    ok("tick2: 정상 drain → status ok", t2.status === "ok");
  }

  // ── (re-gate ③) due 원장 fresh 대상과 중복이면 due 는 skip(이번 tick freshKeys) ──
  {
    const delivered: string[] = [];
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 1, 10)],
        fetchLineupConfirmed: async () => true,
        openSnapshot: async () => Date.now() + 30 * 60_000,
        deliverBatch: async (t) => { delivered.push(`${t.gameId}:${t.teamId}`); return batch(); },
        listDueSnapshots: async () => [
          { gameId: "G1", teamId: 1, snapshotDeadlineAtMs: Date.now() + 60_000, payload: { title: "", body: "", url: "" } },
        ],
      }),
    });
    ok("fresh 처리한 (G1,1) 은 due 에서 skip(중복 drain 0)", delivered.filter((k) => k === "G1:1").length === 1 && r.summary.dueDrained === 0);
  }

  // ── due 조회 실패 → drainError 로 systemic 노출 ──
  {
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 1, 2)],
        fetchLineupConfirmed: async () => false, // 신규 대상 없음
        listDueSnapshots: async () => { throw new Error("due query down"); },
      }),
    });
    ok("due 조회 실패 → drainError·failed", r.summary.drainErrors === 1 && r.status === "failed");
  }

  // ── scheduled-only: cancelled/live/final 은 신규 라인업 조회·대상 제외 ──
  {
    const fetched: string[] = [];
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("A", "scheduled", 1, 2), game("B", "cancelled", 3, 4), game("C", "live", 5, 6), game("D", "final", 7, 8)],
        fetchLineupConfirmed: async (id) => { fetched.push(id); return true; },
        openSnapshot: async () => Date.now() + 60_000, deliverBatch: async () => batch(),
      }),
    });
    ok("scheduled 1경기만 신규 라인업 조회", fetched.length === 1 && fetched[0] === "A");
    ok("scheduled 1경기 → 2 대상", r.summary.targets === 2);
  }

  // ── systemic: fetchGames throw → failed ──
  {
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: base({ fetchGames: async () => { throw new Error("kbo down"); } }),
    });
    ok("KBO 목록 실패 → failed", r.status === "failed" && r.error === "kbo down");
  }

  // ── 대상 0(경기 없음) → ok ──
  {
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: base({ fetchGames: async () => [] }),
    });
    ok("경기 0 → ok", r.status === "ok" && r.summary.scheduled === 0);
  }

  // ── deadline 즉시 → open/drain 0 ──
  {
    let opens = 0, drains = 0;
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: 1_000_000,
      deps: base({
        fetchGames: async () => [game("A", "scheduled", 1, 2)],
        fetchLineupConfirmed: async () => true,
        openSnapshot: async () => { opens++; return 1_000_000 + 60_000; },
        deliverBatch: async () => { drains++; return batch(); },
        now: () => 1_000_000,
      }),
    });
    ok("deadline 즉시 → open/drain 0", opens === 0 && drains === 0);
    void r;
  }

  // ── (삼순 #952 4차 blocker2) 양 팀 FCM transient 로 pending>0 → status failed(부분 FCM 실패 502) ──
  {
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 1, 10)],
        fetchLineupConfirmed: async () => true,
        openSnapshot: async () => Date.now() + 60_000,
        // claim 은 됐지만 FCM transient(pending 잔존) — 예외 아님(drainErrors=0), deadline 안(expired=0).
        deliverBatch: async () => batch({ claimed: 1, pending: 1, snapshotCompleted: false, fcmAcceptedDelta: 0 }),
        finalizeSnapshot: async () => fin({ pending: 2 }),
      }),
    });
    ok("양 팀 FCM transient pending>0 → status failed(502)", r.status === "failed");
    ok("pending 집계 확인(>0)", r.summary.pending > 0 && r.summary.drainErrors === 0 && r.summary.expired === 0);
  }

  // ── 정상 완료(pending=0, drainErrors=0) → status ok (pending 게이트가 정상 tick 을 막지 않음) ──
  {
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: base({
        fetchGames: async () => [game("G1", "scheduled", 1, 10)],
        fetchLineupConfirmed: async () => true,
        openSnapshot: async () => Date.now() + 60_000,
        deliverBatch: async () => batch({ pending: 0 }),
        finalizeSnapshot: async () => fin({ snapshotCompleted: true, pending: 0 }),
      }),
    });
    ok("정상 완료(pending 0) → status ok", r.status === "ok");
  }

  console.log(`\nlineup-watchdog 오케스트레이터: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
