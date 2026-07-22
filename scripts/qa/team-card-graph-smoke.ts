/**
 * 통합 team-card 그래프 회귀 (삼순 #728/#729):
 *  - ① 주간 괄호 순위 = 같은 주차·10구단 competition ranking(동률 보존)
 *  - ② standing.rank + self-heal liveRank = teamCardRank(buildRankMap SSOT), route 우회(1,2,2,4) 차단
 *  - pagination(fetchAllRows) 1000 경계 id 유일정렬 중복0
 * 실행: npx tsx scripts/qa/team-card-graph-smoke.ts
 */
import "./_smoke-env";
import {
  competitionRank,
  weeklyBattingRankMap,
  weeklyPitchingRankMap,
  type WeekGameLogRow,
} from "../../src/lib/analysis/weekly-team-rank";
import { teamCardRank } from "../../src/lib/crawler/kbo-api";
import { appendLiveRankIfStale } from "../../src/lib/analysis/rank-history-selfheal";
import { fetchAllRows } from "../../src/lib/db/paginate";
import type { TeamStanding } from "../../src/lib/crawler/kbo-api";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) pass++;
  else { fail++; console.error(`✗ ${name}`); }
}

// ── ① 주간 competition rank ──────────────────────────────
{
  // 동률(같은 avg) → 같은 순위(1,2,2,4)
  const rank = competitionRank(
    [
      { teamId: 1, value: 0.3 },
      { teamId: 2, value: 0.28 },
      { teamId: 3, value: 0.28 },
      { teamId: 4, value: 0.25 },
    ],
    true,
  );
  ok("① competition rank 동률 1,2,2,4", rank.get(1) === 1 && rank.get(2) === 2 && rank.get(3) === 2 && rank.get(4) === 4);
}
{
  // 주간 타율: 팀1 .300(3/10), 팀2 .200(2/10) → 팀1 1위·팀2 2위. ab=0 팀 제외.
  const rows: WeekGameLogRow[] = [
    { team_id: 1, ab: 10, h: 3, ip_outs: 0, er: 0 },
    { team_id: 2, ab: 10, h: 2, ip_outs: 0, er: 0 },
    { team_id: 3, ab: 0, h: 0, ip_outs: 0, er: 0 }, // 미출전 → 제외
  ];
  const bat = weeklyBattingRankMap(rows);
  ok("① 주간 타율 rank(팀1 1위/팀2 2위/팀3 제외)", bat.get(1) === 1 && bat.get(2) === 2 && bat.get(3) === undefined);
}
{
  // 주간 방어율: 낮을수록 1위. 팀1 er3/9out=9.00, 팀2 er1/9out=3.00 → 팀2 1위.
  const rows: WeekGameLogRow[] = [
    { team_id: 1, ab: 0, h: 0, ip_outs: 9, er: 3 },
    { team_id: 2, ab: 0, h: 0, ip_outs: 9, er: 1 },
  ];
  const pit = weeklyPitchingRankMap(rows);
  ok("① 주간 방어율 rank(낮을수록 1위)", pit.get(2) === 1 && pit.get(1) === 2);
}

// ── ② standing.rank SSOT(buildRankMap 우회 차단) ─────────
function st(teamId: number, winRate: number, ranking?: number): TeamStanding {
  return { teamName: `T${teamId}`, teamId, games: 100, wins: 0, losses: 0, draws: 0, winRate, gamesBehind: 0, ranking };
}
{
  // ranking 원본 있음(1,2,2,4) → 그대로. winRate idx+1이면 3이 나올 자리에 2.
  const standings = [st(1, 0.6, 1), st(2, 0.5, 2), st(3, 0.5, 2), st(4, 0.4, 4)];
  ok("② ranking 원본 공동순위 보존(팀3=2위, idx+1 우회 아님)", teamCardRank(standings, 3) === 2 && teamCardRank(standings, 4) === 4);
}
{
  // ranking 없음 + 승률 동률 → competition 1,2,2,4
  const standings = [st(1, 0.6), st(2, 0.5), st(3, 0.5), st(4, 0.4)];
  ok("② ranking 없음 승률 동률 → 1,2,2,4", teamCardRank(standings, 1) === 1 && teamCardRank(standings, 2) === 2 && teamCardRank(standings, 3) === 2 && teamCardRank(standings, 4) === 4);
}
{
  // self-heal liveRank도 같은 SSOT 값 append (stale → 오늘 포인트 2위, idx+1의 3위 아님)
  const standings = [st(1, 0.6, 1), st(2, 0.5, 2), st(3, 0.5, 2), st(4, 0.4, 4)];
  const live = teamCardRank(standings, 3); // = 2
  const hist = [{ date: "2026-07-18", rank: 2 }, { date: "2026-07-19", rank: 2 }];
  const out = appendLiveRankIfStale(hist, "2026-07-20", live);
  ok("② self-heal liveRank=SSOT 값(2위) append", out[out.length - 1].rank === 2 && out.length === 3);
}

// ── pagination 경계 ─────────────────────────────────────
(async () => {
  {
    // 2100행 전부 같은 날짜, id만 고유 → (date,id) 유일정렬이면 중복0·누락0
    const rows = Array.from({ length: 2100 }, (_, i) => ({ id: i + 1, game_date: "2026-06-01" }));
    const all = await fetchAllRows(async (from, to) => rows.slice(from, to + 1), 1000);
    const ids = new Set(all.map((r) => r.id));
    ok("pagination 경계 중복0·누락0(2100/3페이지)", ids.size === 2100 && all.length === 2100 && ids.has(1000) && ids.has(1001));
  }
  {
    // 정확히 2배수 → 빈 페이지 종료(무한루프 아님)
    const rows = Array.from({ length: 2000 }, (_, i) => ({ id: i }));
    const all = await fetchAllRows(async (from, to) => rows.slice(from, to + 1), 1000);
    ok("pagination 정확 2배수 종료", all.length === 2000);
  }

  console.log(`\nteam-card graph smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
