/**
 * 라인업 확정 watchdog 오케스트레이터 회귀 (삼순 #952 NO-GO 1·2차) — 실제 runLineupWatchdog 를
 * 주입 fake 로 구동. 격리 병렬 파이프라인 · all-null→failed · partial open→failed ·
 * 첫 drain hang 에도 뒤 대상 drain · systemic 실패 status · scheduled-only · deadline.
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
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ── 확정 2경기 → 4 대상 전부 open+drain (격리 병렬) ──
  {
    const opened = new Set<string>();
    const drained = new Set<string>();
    const deps: Partial<LineupWatchdogDeps> = {
      fetchGames: async () => [game("G1", "scheduled", 1, 10), game("G2", "scheduled", 3, 5)],
      fetchLineupConfirmed: async () => true,
      openSnapshot: async (t) => { opened.add(`${t.gameId}:${t.teamId}`); return Date.now() + 60_000; },
      deliverBatch: async (t) => { drained.add(`${t.gameId}:${t.teamId}`); return batch(); },
      now: () => Date.now(),
    };
    const r = await runLineupWatchdog({ dateStr: "20260729", deadlineAtMs: Date.now() + 16_000, deps });
    ok("확정 2경기 → 4 대상 open", opened.size === 4 && r.summary.snapshotsOpened === 4);
    ok("4 대상 전부 drain", drained.size === 4);
    ok("status ok", r.status === "ok" && r.summary.accepted === 4);
  }

  // ── (삼순 P1-1) all-null probe → failed (엔드포인트 열화, 정상 미확정과 구분) ──
  {
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: {
        fetchGames: async () => [game("G1", "scheduled", 1, 2), game("G2", "scheduled", 3, 4)],
        fetchLineupConfirmed: async () => null, // 전건 신호 없음(네트워크/HTTP/파싱 실패 흡수)
        openSnapshot: async () => Date.now() + 60_000,
        deliverBatch: async () => batch(),
        now: () => Date.now(),
      },
    });
    ok("all-null probe → status failed(502)", r.status === "failed");
    ok("all-null → lineupSignals 0", r.summary.lineupSignals === 0);
  }
  // ── all-throw probe → failed (동일 열화) ──
  {
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: {
        fetchGames: async () => [game("G1", "scheduled", 1, 2)],
        fetchLineupConfirmed: async () => { throw new Error("kbo lineup down"); },
        openSnapshot: async () => Date.now() + 60_000,
        deliverBatch: async () => batch(), now: () => Date.now(),
      },
    });
    ok("all-throw probe → status failed", r.status === "failed");
  }

  // ── 건강한 미확정(all-false) → ok, 대상 0 (정상 미확정은 false 신호를 주므로 열화 아님) ──
  {
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: {
        fetchGames: async () => [game("G1", "scheduled", 1, 2), game("G2", "scheduled", 3, 4)],
        fetchLineupConfirmed: async () => false,
        openSnapshot: async () => Date.now() + 60_000, deliverBatch: async () => batch(), now: () => Date.now(),
      },
    });
    ok("건강한 미확정(false) → status ok", r.status === "ok");
    ok("미확정 → 대상 0, signals 2", r.summary.targets === 0 && r.summary.lineupSignals === 2);
  }
  // ── 일부만 신호 있음(1 true, 1 null) → ok (신호 0건 아님) ──
  {
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: {
        fetchGames: async () => [game("G1", "scheduled", 1, 2), game("G2", "scheduled", 3, 4)],
        fetchLineupConfirmed: async (id) => (id === "G1" ? true : null),
        openSnapshot: async () => Date.now() + 60_000, deliverBatch: async () => batch(), now: () => Date.now(),
      },
    });
    ok("1 true + 1 null → ok(신호>0)", r.status === "ok" && r.summary.confirmed === 1 && r.summary.snapshotsOpened === 2);
  }

  // ── (삼순 P1-2) partial open 실패(4 대상 중 3 snapshot RPC 실패) → failed ──
  {
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: {
        fetchGames: async () => [game("G1", "scheduled", 1, 10), game("G2", "scheduled", 3, 5)],
        fetchLineupConfirmed: async () => true,
        openSnapshot: async (t) => {
          if (`${t.gameId}:${t.teamId}` === "G1:1") return Date.now() + 60_000; // 1개만 성공
          throw new Error("db down");
        },
        deliverBatch: async () => batch(), now: () => Date.now(),
      },
    });
    ok("4 대상 중 3 open 실패 → failed(durable health 불량)", r.status === "failed");
    ok("open 성공 1·실패 3 집계", r.summary.snapshotsOpened === 1 && r.summary.snapshotOpenErrors === 3);
  }

  // ── (삼순 P1-2) 격리: 첫 대상 drain hang(늦게 reject)이어도 뒤 대상들은 drain 완주 ──
  {
    const drained = new Set<string>();
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: {
        fetchGames: async () => [game("G1", "scheduled", 1, 10), game("G2", "scheduled", 3, 5), game("G3", "scheduled", 6, 7)],
        fetchLineupConfirmed: async () => true,
        openSnapshot: async () => Date.now() + 60_000,
        deliverBatch: async (t) => {
          const key = `${t.gameId}:${t.teamId}`;
          if (key === "G1:1") { await later(40); throw new Error("rpc abort (deadline)"); } // 첫 대상 hang→reject
          drained.add(key);
          return batch();
        },
        now: () => Date.now(),
      },
    });
    ok("첫 대상 drain hang 이어도 뒤 5 대상 전부 drain(격리)", drained.size === 5);
    ok("첫 대상 drain 실패 집계(drainErrors 1)", r.summary.drainErrors === 1);
    ok("open 6 성공이므로 status ok(open 실패 없음)", r.status === "ok" && r.summary.snapshotsOpened === 6);
  }

  // ── scheduled-only: cancelled/live/final 은 라인업 조회·대상 제외 ──
  {
    const fetched: string[] = [];
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: {
        fetchGames: async () => [game("A", "scheduled", 1, 2), game("B", "cancelled", 3, 4), game("C", "live", 5, 6), game("D", "final", 7, 8)],
        fetchLineupConfirmed: async (id) => { fetched.push(id); return true; },
        openSnapshot: async () => Date.now() + 60_000, deliverBatch: async () => batch(), now: () => Date.now(),
      },
    });
    ok("scheduled 1경기만 라인업 조회", fetched.length === 1 && fetched[0] === "A");
    ok("scheduled 1경기 → 2 대상", r.summary.targets === 2);
  }

  // ── systemic ①: fetchGames throw → failed ──
  {
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: { fetchGames: async () => { throw new Error("kbo down"); }, now: () => Date.now() },
    });
    ok("KBO 목록 실패 → failed", r.status === "failed" && r.error === "kbo down");
  }

  // ── 대상 0(경기 없음) → ok ──
  {
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: Date.now() + 16_000,
      deps: { fetchGames: async () => [], now: () => Date.now() },
    });
    ok("경기 0 → ok(신호 probe 0이라 열화 아님)", r.status === "ok" && r.summary.scheduled === 0);
  }

  // ── deadline 즉시 → open/drain 0 ──
  {
    let opens = 0, drains = 0;
    const r = await runLineupWatchdog({
      dateStr: "20260729", deadlineAtMs: 1_000_000,
      deps: {
        fetchGames: async () => [game("A", "scheduled", 1, 2)],
        fetchLineupConfirmed: async () => true,
        openSnapshot: async () => { opens++; return 1_000_000 + 60_000; },
        deliverBatch: async () => { drains++; return batch(); },
        now: () => 1_000_000,
      },
    });
    ok("deadline 즉시 → open/drain 0", opens === 0 && drains === 0);
    void r;
  }

  console.log(`\nlineup-watchdog 오케스트레이터: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
