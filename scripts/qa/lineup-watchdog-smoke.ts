/**
 * 라인업 확정 watchdog 오케스트레이터 회귀 (삼순 #952 NO-GO ①②) — 실제 runLineupWatchdog 를
 * 주입 fake 로 구동. snapshot-first 순서 · systemic 실패 status · scheduled-only · 공정 drain · deadline.
 * 실행: npm run qa:lineup-watchdog
 */
import "./_smoke-env"; // supabase/admin 싱글톤이 모듈 로드 시 env 요구 → 더미 선주입(fake 주입이라 실 호출 없음)
import { runLineupWatchdog, type LineupWatchdogDeps } from "../../src/lib/notifications/lineup-watchdog";
import type { KboGame } from "../../src/lib/crawler/kbo-api";

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
function batch(over: Partial<{ claimed: number; pending: number; snapshotCompleted: boolean; fcmAcceptedDelta: number }> = {}) {
  return {
    claimed: over.claimed ?? 1, pending: over.pending ?? 0,
    snapshotCompleted: over.snapshotCompleted ?? true, fcmAcceptedDelta: over.fcmAcceptedDelta ?? 1,
    fcmAcceptedTotal: 1, permanentFailed: 0, expired: 0,
  };
}

async function main() {
  // ── snapshot-first: 모든 open 이 어떤 drain 보다 먼저 (앞 팀 느린 drain 이 뒤 팀 원장 생성을 못 굶김) ──
  {
    const log: string[] = [];
    const games = [game("20260729LGWO0", "scheduled", 1, 10), game("20260729KTNC0", "scheduled", 3, 5)];
    const deps: Partial<LineupWatchdogDeps> = {
      fetchGames: async () => games,
      fetchLineupConfirmed: async () => true,
      openSnapshot: async (t) => { log.push(`open:${t.gameId}:${t.teamId}`); return Date.now() + 60_000; },
      deliverBatch: async (t) => { log.push(`drain:${t.gameId}:${t.teamId}`); return batch(); },
      now: () => Date.now(),
    };
    const r = await runLineupWatchdog({ dateStr: "20260729", deadlineAtMs: Date.now() + 16_000, deps });
    const firstDrain = log.findIndex((l) => l.startsWith("drain:"));
    const lastOpen = log.map((l) => l.startsWith("open:")).lastIndexOf(true);
    ok("확정 2경기 → 4 대상 snapshot", r.summary.snapshotsOpened === 4);
    ok("snapshot-first: 모든 open 이 첫 drain 보다 앞", lastOpen < firstDrain);
    ok("status ok", r.status === "ok");
    ok("accepted 집계", r.summary.accepted === 4);
  }

  // ── scheduled-only: cancelled/live/final 은 라인업 조회·대상 제외 (fail-safe) ──
  {
    const fetched: string[] = [];
    const games = [
      game("A", "scheduled", 1, 2), game("B", "cancelled", 3, 4),
      game("C", "live", 5, 6), game("D", "final", 7, 8),
    ];
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: {
        fetchGames: async () => games,
        fetchLineupConfirmed: async (id) => { fetched.push(id); return true; },
        openSnapshot: async () => Date.now() + 60_000,
        deliverBatch: async () => batch(),
        now: () => Date.now(),
      },
    });
    ok("scheduled 1경기만 라인업 조회", fetched.length === 1 && fetched[0] === "A");
    ok("scheduled 1경기 → 2 대상", r.summary.targets === 2);
  }

  // ── 미확정/ null 은 대상 아님 ──
  {
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: {
        fetchGames: async () => [game("A", "scheduled", 1, 2), game("B", "scheduled", 3, 4)],
        fetchLineupConfirmed: async (id) => (id === "A" ? false : null),
        openSnapshot: async () => Date.now() + 60_000,
        deliverBatch: async () => batch(),
        now: () => Date.now(),
      },
    });
    ok("미확정(false)·신호없음(null) → 대상 0", r.summary.targets === 0 && r.summary.confirmed === 0);
    ok("대상 0 → status ok(정상)", r.status === "ok");
  }

  // ── systemic 실패 ①: fetchGames throw → failed ──
  {
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: { fetchGames: async () => { throw new Error("kbo down"); }, now: () => Date.now() },
    });
    ok("KBO 목록 실패 → status failed(non-2xx)", r.status === "failed" && r.error === "kbo down");
  }

  // ── systemic 실패 ②: 확정 대상 있는데 snapshot 전건 실패 → failed(false-green 차단) ──
  {
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: {
        fetchGames: async () => [game("A", "scheduled", 1, 2)],
        fetchLineupConfirmed: async () => true,
        openSnapshot: async () => { throw new Error("db down"); },
        deliverBatch: async () => batch(),
        now: () => Date.now(),
      },
    });
    ok("확정 대상 있는데 원장 0개 → failed", r.status === "failed" && r.summary.snapshotOpenErrors === 2 && r.summary.snapshotsOpened === 0);
  }

  // ── systemic 실패 ③: 라인업 조회 전건 throw → failed ──
  {
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: {
        fetchGames: async () => [game("A", "scheduled", 1, 2), game("B", "scheduled", 3, 4)],
        fetchLineupConfirmed: async () => { throw new Error("lineup fetch fail"); },
        openSnapshot: async () => Date.now() + 60_000,
        deliverBatch: async () => batch(),
        now: () => Date.now(),
      },
    });
    ok("라인업 조회 전건 실패 → failed", r.status === "failed");
  }

  // ── 공정 round-robin: 대상별 1 batch 씩 순회(t1,t2,t1,t2), 한 대상 독점 아님 ──
  {
    const drainLog: string[] = [];
    const pendingLeft: Record<string, number> = { "A:1": 2, "A:2": 2 };
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: {
        fetchGames: async () => [game("A", "scheduled", 1, 2)],
        fetchLineupConfirmed: async () => true,
        openSnapshot: async () => Date.now() + 60_000,
        deliverBatch: async (t) => {
          const key = `${t.gameId}:${t.teamId}`;
          drainLog.push(key);
          pendingLeft[key] -= 1;
          const p = pendingLeft[key] > 0 ? 1 : 0;
          // 실제 finalize 는 pending=0 인 완료 batch 에서만 snapshotCompleted=true.
          return batch({ pending: p, snapshotCompleted: p === 0 });
        },
        now: () => Date.now(),
      },
    });
    ok("두 대상 각 2 batch drain", drainLog.length === 4);
    ok("round-robin 인터리브(A:1,A:2,A:1,A:2)", drainLog[0] !== drainLog[1] && drainLog[1] === drainLog[3]);
    ok("전 대상 완료 → snapshotsCompleted 2", r.summary.snapshotsCompleted === 2);
  }

  // ── deadline: 예산 소진이면 drain 진입 안 함 ──
  {
    const clock = 1_000_000;
    const games = [game("A", "scheduled", 1, 2)];
    let drained = 0;
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: 1_000_000, // 시작부터 deadline
      deps: {
        fetchGames: async () => games,
        fetchLineupConfirmed: async () => true,
        openSnapshot: async () => clock + 60_000,
        deliverBatch: async () => { drained++; return batch(); },
        now: () => clock,
      },
    });
    ok("deadline 즉시 → drain 0회", drained === 0);
    void r;
  }

  console.log(`\nlineup-watchdog 오케스트레이터: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
