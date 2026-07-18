/**
 * 순위 AI분석 live 트리거 정책 회귀 스모크 (삼순 PR #690 NO-GO 2건 대응).
 * 실행: npx tsx scripts/qa/daily-analysis-live-smoke.ts  (npm run qa:daily-live)
 *
 * 커버: P0① readiness gate(+10팀 sanity·타이틀 settle) / P0② catch-up 타깃 해석 + 멱등성 +
 *       원자적 claim(stale→retry→ready→1회 저장 회귀 포함).
 */
import {
  evaluateLiveReadiness,
  resolveLiveTarget,
  isAlreadyReflected,
  runLiveAnalysisWithClaim,
  shouldReleaseAfterRun,
  type ReadinessStandingRow,
  type ReadinessCurrentStanding,
  type ReadinessTitleRow,
  type SlateState,
  type LiveClaimOutcome,
} from "../../src/lib/analysis/daily-analysis-live-policy";

let pass = 0;
let fail = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass++;
  else {
    fail++;
    console.error(`✗ ${name}\n  got:  ${g}\n  want: ${w}`);
  }
}
function ok(name: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

// ===== P0① readiness =====
// baseline: 10팀 전부 100경기(오늘 경기 전), 오늘 팀1 vs 팀2 final 1경기
const baselineStandings: ReadinessStandingRow[] = Array.from({ length: 10 }, (_, i) => ({
  team_id: i + 1,
  wins: 50,
  losses: 45,
  draws: 5,
})); // 각 100
const todayFinalGames = [{ awayTeamId: 1, homeTeamId: 2 }];
const baselineStats: ReadinessTitleRow[] = [
  { category: "hr", rank: 1, player_name: "A", value: 30 },
  { category: "avg", rank: 1, player_name: "B", value: 0.35 },
];
const statsMoved: ReadinessTitleRow[] = [
  { category: "hr", rank: 1, player_name: "A", value: 31 },
  { category: "avg", rank: 1, player_name: "B", value: 0.35 },
];
const full = (over: Partial<Record<number, [number, number, number]>>): ReadinessCurrentStanding[] =>
  Array.from({ length: 10 }, (_, i) => {
    const id = i + 1;
    const o = over[id];
    return o
      ? { teamId: id, wins: o[0], losses: o[1], draws: o[2] }
      : { teamId: id, wins: 50, losses: 45, draws: 5 };
  });

// 경계값 1: 순위표 stale(팀1/팀2 아직 100) → not ready
check(
  "P0① 순위표 stale → not ready",
  evaluateLiveReadiness({ baselineStandings, currentStandings: full({}), todayFinalGames, baselineStats, currentStats: statsMoved }),
  { ready: false, reason: "standings not settled: teams 1,2", laggingTeams: [1, 2] },
);
// 경계값 2: 순위표 반영(팀1/팀2 101)됐고 타이틀도 갱신 → ready(=1회 저장 대상)
check(
  "P0① 순위+타이틀 반영 → ready",
  evaluateLiveReadiness({
    baselineStandings,
    currentStandings: full({ 1: [51, 45, 5], 2: [48, 48, 5] }),
    todayFinalGames,
    baselineStats,
    currentStats: statsMoved,
  }),
  { ready: true, reason: "ready", laggingTeams: [] },
);
// 타이틀 stale(baseline과 동일) → not ready
check(
  "P0① 타이틀 stale → not ready",
  evaluateLiveReadiness({
    baselineStandings,
    currentStandings: full({ 1: [51, 45, 5], 2: [48, 48, 5] }),
    todayFinalGames,
    baselineStats,
    currentStats: baselineStats,
  }),
  { ready: false, reason: "titles not settled (identical to baseline)", laggingTeams: [] },
);
// 10팀 sanity: 부분 응답(9팀) → not ready
check(
  "P0① 부분 응답(9팀) → not ready",
  evaluateLiveReadiness({
    baselineStandings,
    currentStandings: full({ 1: [51, 45, 5], 2: [48, 48, 5] }).slice(0, 9),
    todayFinalGames,
    baselineStats,
    currentStats: statsMoved,
  }),
  { ready: false, reason: "standings partial response: 9/10 teams", laggingTeams: [] },
);
// 무승부 경기수 반영 + 올스타(teamId 0) 제외
check(
  "P0① 무승부 반영 + 올스타 제외 → ready",
  evaluateLiveReadiness({
    baselineStandings,
    currentStandings: full({ 1: [50, 45, 6], 2: [48, 47, 6] }),
    todayFinalGames: [{ awayTeamId: 1, homeTeamId: 2 }, { awayTeamId: 0, homeTeamId: 0 }],
    baselineStats,
    currentStats: statsMoved,
  }),
  { ready: true, reason: "ready", laggingTeams: [] },
);

// ===== P0② 타깃 해석(catch-up) =====
const terminal = (finals: number): SlateState => ({ hasGames: true, allTerminal: true, finalCount: finals });
const inProgress: SlateState = { hasGames: true, allTerminal: false, finalCount: 1 };
const noGames: SlateState = { hasGames: false, allTerminal: false, finalCount: 0 };

check(
  "P0② 정상 당일: 오늘 전부 종료 → gameDate=saveDate=오늘",
  resolveLiveTarget({ todayISO: "2026-07-18", yesterdayISO: "2026-07-17", today: terminal(5), yesterday: terminal(5) }),
  { gameDate: "2026-07-18", saveDate: "2026-07-18" },
);
check(
  "P0② catch-up: 오늘 진행중·어제 전부종료 → gameDate=어제·saveDate=오늘",
  resolveLiveTarget({ todayISO: "2026-07-19", yesterdayISO: "2026-07-18", today: inProgress, yesterday: terminal(5) }),
  { gameDate: "2026-07-18", saveDate: "2026-07-19" },
);
check(
  "P0② catch-up: 오늘 경기없음·어제 전부종료 → 어제 catch-up",
  resolveLiveTarget({ todayISO: "2026-07-19", yesterdayISO: "2026-07-18", today: noGames, yesterday: terminal(5) }),
  { gameDate: "2026-07-18", saveDate: "2026-07-19" },
);
check(
  "P0② 처리 대상 없음(오늘 진행중·어제도 미종료) → null",
  resolveLiveTarget({ todayISO: "2026-07-19", yesterdayISO: "2026-07-18", today: inProgress, yesterday: inProgress }),
  null,
);
check(
  "P0② 전부 우천취소(final 0) → null",
  resolveLiveTarget({ todayISO: "2026-07-18", yesterdayISO: "2026-07-17", today: terminal(0), yesterday: terminal(0) }),
  null,
);

// ===== 멱등성 =====
ok("멱등: 정상 당일 마커 있으면 반영됨", isAlreadyReflected("2026-07-18", "2026-07-18", { sameDayLive: true, lastUpdated: "2026-07-18" }) === true);
ok("멱등: 정상 당일 scheduled 어제분석은 미반영", isAlreadyReflected("2026-07-18", "2026-07-18", { lastUpdated: "2026-07-17" }) === false);
ok("멱등: 정상 당일 행 없으면 미반영", isAlreadyReflected("2026-07-18", "2026-07-18", null) === false);
ok("멱등: catch-up saveDate 행 존재하면 반영됨", isAlreadyReflected("2026-07-18", "2026-07-19", { lastUpdated: "2026-07-18" }) === true);
ok("멱등: catch-up 행 없으면 미반영", isAlreadyReflected("2026-07-18", "2026-07-19", null) === false);

// ===== 원자적 claim + stale→retry→ready→1회 저장 회귀 =====
ok("claim: not_ready → release", shouldReleaseAfterRun({ status: 200, body: { skipped: "not_ready" } }) === true);
ok("claim: 500 → release", shouldReleaseAfterRun({ status: 500, body: {} }) === true);
ok("claim: 정상 생성 → 유지", shouldReleaseAfterRun({ status: 200, body: { ok: true } }) === false);

async function main() {
  // claim 실패(동시 실행) → run/release 미호출
  {
    let ran = false;
    let released = false;
    const out = await runLiveAnalysisWithClaim({
      claim: async () => false,
      release: async () => { released = true; },
      run: async () => { ran = true; return { status: 200, body: { ok: true } }; },
    });
    ok("claim 실패 → run 미호출", ran === false);
    ok("claim 실패 → release 미호출", released === false);
    ok("claim 실패 → concurrent skip", (out.body as Record<string, unknown>).skipped === "claim held by concurrent run");
  }

  // stale→retry→ready→1회 저장 회귀:
  //  tick1: claim 성공 → run not_ready → release(다음 tick 재시도)
  //  tick2: claim 성공 → run 정상 생성 → release 미호출(멱등성 마커가 이후 tick 차단)
  {
    let releases = 0;
    const runResults: LiveClaimOutcome[] = [
      { status: 200, body: { ok: true, skipped: "not_ready", reason: "standings not settled: teams 1" } },
      { status: 200, body: { ok: true, mode: "live", gamesAnalyzed: 5 } },
    ];
    let i = 0;
    const deps = {
      claim: async () => true,
      release: async () => { releases++; },
      run: async () => runResults[i++],
    };
    const t1 = await runLiveAnalysisWithClaim(deps);
    const t2 = await runLiveAnalysisWithClaim(deps);
    ok("회귀 tick1 not_ready → release", (t1.body as Record<string, unknown>).skipped === "not_ready");
    ok("회귀 tick2 정상 생성", (t2.body as Record<string, unknown>).gamesAnalyzed === 5);
    ok("회귀: release는 stale tick에서만 1회", releases === 1);
  }

  // 생성 중 예외 → release 후 재던짐
  {
    let released = false;
    let threw = false;
    try {
      await runLiveAnalysisWithClaim({
        claim: async () => true,
        release: async () => { released = true; },
        run: async () => { throw new Error("gemini down"); },
      });
    } catch {
      threw = true;
    }
    ok("예외 → release 호출", released === true);
    ok("예외 → 재던짐", threw === true);
  }

  console.log(`\ndaily-analysis-live smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
