/**
 * 순위 AI분석 live 트리거 정책 회귀 스모크 (삼순 PR #690 NO-GO 2건 대응).
 * 실행: npx tsx scripts/qa/daily-analysis-live-smoke.ts  (npm run qa:daily-live)
 *
 * 커버: P0① readiness gate(+10팀 sanity·타이틀 settle) / P0② catch-up 타깃 해석 + 멱등성 +
 *       원자적 claim(stale→retry→ready→1회 저장 회귀 포함).
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  evaluateLiveReadiness,
  resolveLiveTarget,
  isAlreadyReflected,
  runLiveAnalysisWithClaim,
  shouldReleaseAfterRun,
  interpretClaimRpc,
  assertLookupOk,
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

// prod 타이틀 계약: 9종 각 10 유효·고유 행(빈 선수명 0). 스모크 fixture도 이 계약을 모방한다.
const TITLE_CATS = ["avg", "hr", "rbi", "sb", "era", "wins", "k", "saves", "whip"];
function titlesFor(
  cats: string[],
  opts?: { rows?: number; bump?: number; blank?: boolean },
): ReadinessTitleRow[] {
  const rows: ReadinessTitleRow[] = [];
  const n = opts?.rows ?? 10;
  const bump = opts?.bump ?? 0;
  for (const cat of cats) {
    for (let rank = 1; rank <= n; rank++) {
      rows.push({
        category: cat,
        rank,
        player_name: opts?.blank ? "" : `${cat}-P${rank}`,
        value: rank + bump,
      });
    }
  }
  return rows;
}
// baseline = 9종×10 완전 snapshot / moved = 값 이동(≠baseline)하되 10 유효·고유 행 유지.
const baselineStats: ReadinessTitleRow[] = titlesFor(TITLE_CATS);
const statsMoved: ReadinessTitleRow[] = titlesFor(TITLE_CATS, { bump: 100 });
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

// ===== P0③ 불완전/혼합 원천 false-ready 방지 (삼순 재리뷰 3건 재현) =====
// (a) baseline 1·2팀 누락 → 누락 팀 0 대체로 false-ready 되던 것 → not ready
check(
  "P0③ baseline 불완전(8팀) → not ready",
  evaluateLiveReadiness({
    baselineStandings: baselineStandings.slice(0, 8),
    currentStandings: full({ 1: [51, 45, 5], 2: [48, 48, 5] }),
    todayFinalGames,
    baselineStats,
    currentStats: statsMoved,
  }),
  { ready: false, reason: "baseline incomplete: 8/10 teams", laggingTeams: [] },
);
// (b) currentStats=[] (빈 타이틀 원천) → baseline과 "다르다"고 통과하던 것 → not ready(incomplete)
check(
  "P0③ 빈 타이틀 원천 → not ready",
  evaluateLiveReadiness({
    baselineStandings,
    currentStandings: full({ 1: [51, 45, 5], 2: [48, 48, 5] }),
    todayFinalGames,
    baselineStats,
    currentStats: [],
  }),
  { ready: false, reason: "titles incomplete: avg 0/10 valid unique rows", laggingTeams: [] },
);
// (c) 현재 경기수 expected+1(혼합·과반영) → current>=expected로 통과하던 것 → not ready(정확일치)
check(
  "P0③ 경기수 expected+1 과반영 → not ready",
  evaluateLiveReadiness({
    baselineStandings,
    currentStandings: full({ 1: [52, 45, 5], 2: [48, 48, 5] }),
    todayFinalGames,
    baselineStats,
    currentStats: statsMoved,
  }),
  { ready: false, reason: "standings not settled: teams 1", laggingTeams: [1] },
);
// (d) 타이틀 카테고리 1개만 반영(hr만, avg 누락) → not ready(incomplete)
check(
  "P0③ 타이틀 카테고리 부분 반영 → not ready",
  evaluateLiveReadiness({
    baselineStandings,
    currentStandings: full({ 1: [51, 45, 5], 2: [48, 48, 5] }),
    todayFinalGames,
    baselineStats,
    currentStats: [{ category: "hr", rank: 1, player_name: "A", value: 31 }],
  }),
  { ready: false, reason: "titles incomplete: avg 0/10 valid unique rows", laggingTeams: [] },
);
// (e) [삼순 e559951e 재리뷰] baselineStats=[] → 기존엔 타이틀 체크 자체를 건너뛰어 ready=true였던 구멍 → not ready
check(
  "P0③ baselineStats=[] → not ready(fail-closed)",
  evaluateLiveReadiness({
    baselineStandings,
    currentStandings: full({ 1: [51, 45, 5], 2: [48, 48, 5] }),
    todayFinalGames,
    baselineStats: [],
    currentStats: statsMoved,
  }),
  { ready: false, reason: "baseline titles empty", laggingTeams: [] },
);
// (f) [삼순 e559951e 재리뷰] baseline 자체가 부분 카테고리(avg 누락) → 기대 카테고리 기준 not ready
//   hr은 10 유효행으로 채워 행수 게이트를 통과시켜도 avg가 0행이라 기대 카테고리에서 걸린다.
check(
  "P0③ baseline 부분 카테고리(expected 기준) → not ready",
  evaluateLiveReadiness({
    baselineStandings,
    currentStandings: full({ 1: [51, 45, 5], 2: [48, 48, 5] }),
    todayFinalGames,
    baselineStats: titlesFor(["hr"]),
    currentStats: titlesFor(["hr"], { bump: 1 }),
    expectedTitleCategories: ["hr", "avg"],
  }),
  { ready: false, reason: "baseline titles incomplete: avg 0/10 valid unique rows", laggingTeams: [] },
);
// (g) expectedTitleCategories 모두 충족 + settle → ready (core 실제 경로 모방)
check(
  "P0③ expected 카테고리 완전 충족 → ready",
  evaluateLiveReadiness({
    baselineStandings,
    currentStandings: full({ 1: [51, 45, 5], 2: [48, 48, 5] }),
    todayFinalGames,
    baselineStats: titlesFor(["hr", "avg"]),
    currentStats: titlesFor(["hr", "avg"], { bump: 1 }),
    expectedTitleCategories: ["hr", "avg"],
  }),
  { ready: true, reason: "ready", laggingTeams: [] },
);

// ===== [삼순 f9f5e5bf 재리뷰] 타이틀 행 단위 완전성 fail-open 차단 (9종×1행 / 9종×10 blank / 중복 행) =====
const settledStandings = full({ 1: [51, 45, 5], 2: [48, 48, 5] });
// (1) current가 카테고리당 1행뿐인 부분 snapshot → 임계 10 미달로 not ready
check(
  "행완전성: current 9종×1행 부분 snapshot → not ready",
  evaluateLiveReadiness({
    baselineStandings,
    currentStandings: settledStandings,
    todayFinalGames,
    baselineStats,
    currentStats: titlesFor(TITLE_CATS, { rows: 1, bump: 5 }),
  }),
  { ready: false, reason: "titles incomplete: avg 1/10 valid unique rows", laggingTeams: [] },
);
// (1b) baseline이 카테고리당 1행 → baseline 쪽도 fail-closed
check(
  "행완전성: baseline 9종×1행 부분 snapshot → not ready",
  evaluateLiveReadiness({
    baselineStandings,
    currentStandings: settledStandings,
    todayFinalGames,
    baselineStats: titlesFor(TITLE_CATS, { rows: 1 }),
    currentStats: statsMoved,
  }),
  { ready: false, reason: "baseline titles incomplete: avg 1/10 valid unique rows", laggingTeams: [] },
);
// (2) current가 9종×10행이나 전부 player_name=""(구조적 빈 응답) → 유효행 0으로 not ready
check(
  "행완전성: current 9종×10 blank 선수명 → not ready",
  evaluateLiveReadiness({
    baselineStandings,
    currentStandings: settledStandings,
    todayFinalGames,
    baselineStats,
    currentStats: titlesFor(TITLE_CATS, { blank: true }),
  }),
  { ready: false, reason: "titles incomplete: avg 0/10 valid unique rows", laggingTeams: [] },
);
// (3) current avg가 10행이나 rank1 완전 복제 포함(고유 9) → 중복 행 fault not ready
{
  const dupCurrent = titlesFor(TITLE_CATS, { bump: 3 });
  // avg rank10 행을 rank1 완전 복제로 교체 → avg는 10행이나 고유 9행
const avgIdx10 = dupCurrent.findIndex((r) => r.category === "avg" && r.rank === 10);
  const avgRow1 = dupCurrent.find((r) => r.category === "avg" && r.rank === 1)!;
  dupCurrent[avgIdx10] = { ...avgRow1 };
  check(
    "행완전성: current avg 중복 행 fault(고유 9) → not ready",
    evaluateLiveReadiness({
      baselineStandings,
      currentStandings: settledStandings,
      todayFinalGames,
      baselineStats,
      currentStats: dupCurrent,
    }),
    { ready: false, reason: "titles incomplete: avg 9/10 valid unique rows", laggingTeams: [] },
  );
}
// (4) rank/value 비유효(NaN) 행은 유효행에서 제외되어 임계 미달
check(
  "행완전성: current value NaN 행 제외 → not ready",
  evaluateLiveReadiness({
    baselineStandings,
    currentStandings: settledStandings,
    todayFinalGames,
    baselineStats,
    currentStats: titlesFor(TITLE_CATS, { bump: 2 }).map((r) =>
      r.category === "avg" && r.rank === 10 ? { ...r, value: Number.NaN } : r,
    ),
  }),
  { ready: false, reason: "titles incomplete: avg 9/10 valid unique rows", laggingTeams: [] },
);

// ===== P0① 실제 cron 시간대 회귀 (자정 catch-up 구간이 vercel.json cron에 실제로 있는지) =====
// cron hour 필드 → UTC 시간 집합 (A-B 범위 / 단일 H / 쉼표 복수 지원).
function cronUtcHours(schedule: string): number[] {
  const hourField = schedule.trim().split(/\s+/)[1];
  const out: number[] = [];
  for (const part of hourField.split(",")) {
    if (part === "*") { for (let h = 0; h < 24; h++) out.push(h); }
    else if (part.includes("-")) { const [a, b] = part.split("-").map(Number); for (let h = a; h <= b; h++) out.push(h); }
    else out.push(Number(part));
  }
  return out;
}
const toKst = (utc: number) => (utc + 9) % 24;
{
  const vercelPath = join(dirname(fileURLToPath(import.meta.url)), "../../vercel.json");
  const vercel = JSON.parse(readFileSync(vercelPath, "utf8")) as { crons: { path: string; schedule: string }[] };
  const liveCron = vercel.crons.find((c) => c.path === "/api/cron/daily-analysis-live");
  const schedCron = vercel.crons.find((c) => c.path === "/api/cron/daily-analysis");
  ok("P0① cron: live 크론 존재", !!liveCron);
  ok("P0① cron: scheduled 백스톱 크론 존재", !!schedCron);
  if (liveCron && schedCron) {
    const liveKst = new Set(cronUtcHours(liveCron.schedule).map(toKst));
    ok("P0① cron: live가 자정 catch-up(KST 0시) 구간 포함", liveKst.has(0));
    ok("P0① cron: live가 저녁(KST 16~23시) 구간 포함", [16, 17, 18, 19, 20, 21, 22, 23].every((h) => liveKst.has(h)));
    // scheduled 백스톱은 KST 1시(UTC 16). live는 KST 1시를 침범하면 안 됨(백스톱과 레이스).
    ok("P0① cron: scheduled 백스톱 KST 1시(UTC 16)", toKst(cronUtcHours(schedCron.schedule)[0]) === 1);
    ok("P0① cron: live 마지막 tick(KST 0:50)이 scheduled(KST 1:00) 이전", !liveKst.has(1));
  }
}

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

  // P0② 실제 route 해석 로직(interpretClaimRpc/assertLookupOk) 검증 — mock이 아닌 route가 쓰는 순수함수 그대로.
  //   조회/claim 오류는 throw(5xx), 정상 contention(data!==true)만 false, error 없는 data===true만 성공.
  ok("P0② interpretClaimRpc: data=true → true", interpretClaimRpc({ data: true, error: null }) === true);
  ok("P0② interpretClaimRpc: data=false(contention) → false", interpretClaimRpc({ data: false, error: null }) === false);
  {
    let threw = false;
    try { interpretClaimRpc({ data: null, error: { message: "relation does not exist" } }); } catch { threw = true; }
    ok("P0② interpretClaimRpc: RPC error → throw(5xx, false로 숨김 ❌)", threw === true);
  }
  ok("P0② assertLookupOk: error 없으면 통과", (() => { assertLookupOk({ error: null }, "x"); return true; })());
  {
    let threw = false;
    try { assertLookupOk({ error: { message: "permission denied" } }, "existing analysis"); } catch { threw = true; }
    ok("P0② assertLookupOk: 조회 error → throw(5xx, 미반영 축약 ❌)", threw === true);
  }
  // interpretClaimRpc가 throw하면 runLiveAnalysisWithClaim을 통해 run/release 미호출·전파(route가 catch→5xx)
  {
    let ran = false;
    let released = false;
    let threw = false;
    try {
      await runLiveAnalysisWithClaim({
        claim: async () => interpretClaimRpc({ data: null, error: { message: "relation does not exist" } }),
        release: async () => { released = true; },
        run: async () => { ran = true; return { status: 200, body: { ok: true } }; },
      });
    } catch {
      threw = true;
    }
    ok("P0② claim RPC 오류 → 전파(route 5xx)", threw === true);
    ok("P0② claim RPC 오류 → run 미호출", ran === false);
    ok("P0② claim RPC 오류 → release 미호출", released === false);
  }

  console.log(`\ndaily-analysis-live smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
