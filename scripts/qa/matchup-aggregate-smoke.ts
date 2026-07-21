/**
 * 스모크: 팀 상대전적 집계 정규시즌 필터 — 2026-07-21 (#cs 제보 "롯데 47승49패" fix).
 *   ① 시범경기(srId 1) 제외 / 정규(srId 0)만 집계
 *   ② 포스트시즌(srId 3/4/5/7) 제외
 *   ③ final 아닌 경기·타팀 경기·null 스코어 제외 (기존 계약 유지)
 *   ④ 승/패/무 분류 + 상대별 분리
 * 실행: npm run qa:matchup-aggregate
 */
import type { KboGame } from "../../src/lib/crawler/kbo-api";
import { aggregateMatchups } from "../../src/lib/team/matchup-aggregate";

let pass = 0;
let fail = 0;
function check(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
  } else {
    fail++;
    console.error(`  ✗ ${label}: got ${g}, want ${w}`);
  }
}

function game(p: Partial<KboGame>): KboGame {
  return {
    gameId: "20260701AABB0",
    date: "20260701",
    time: "18:30",
    stadium: "잠실",
    srId: 0,
    awayTeamId: 1,
    homeTeamId: 2,
    awayName: "A",
    homeName: "B",
    awayScore: 0,
    homeScore: 0,
    inning: 9,
    isTop: false,
    status: "final",
    ...p,
  } as KboGame;
}

// 팀 2 기준: 정규 홈승 + 정규 원정패 + 시범 홈승(제외돼야) + 포스트 홈승(제외) + 무승부
const games: KboGame[] = [
  game({ srId: 0, homeTeamId: 2, awayTeamId: 1, homeScore: 5, awayScore: 3 }), // 정규 승
  game({ srId: 0, homeTeamId: 3, awayTeamId: 2, homeScore: 4, awayScore: 1 }), // 정규 패 (원정)
  game({ srId: 0, homeTeamId: 2, awayTeamId: 3, homeScore: 2, awayScore: 2 }), // 정규 무
  game({ srId: 1, homeTeamId: 2, awayTeamId: 1, homeScore: 9, awayScore: 0 }), // 시범 승 → 제외
  game({ srId: 1, homeTeamId: 1, awayTeamId: 2, homeScore: 7, awayScore: 2 }), // 시범 패 → 제외
  game({ srId: 5, homeTeamId: 2, awayTeamId: 1, homeScore: 3, awayScore: 1 }), // 포스트 → 제외
  game({ srId: 0, homeTeamId: 2, awayTeamId: 1, homeScore: 6, awayScore: 2, status: "live" }), // live → 제외
  game({ srId: 0, homeTeamId: 4, awayTeamId: 5, homeScore: 1, awayScore: 0 }), // 타팀 → 제외
  game({ srId: 0, homeTeamId: 2, awayTeamId: 1, homeScore: null, awayScore: null }), // null 스코어 → 제외
];

const { byOpponent, total } = aggregateMatchups(games, 2);
check("total = 정규 1승 1패 1무", total, { wins: 1, losses: 1, draws: 1 });
check("vs 팀1 = 1승 (시범 2경기 제외)", byOpponent.get(1), { wins: 1, losses: 0, draws: 0 });
check("vs 팀3 = 1패 1무", byOpponent.get(3), { wins: 0, losses: 1, draws: 1 });
check("vs 팀4 없음(타팀 경기 미집계)", byOpponent.get(4), undefined);

// srId 누락(구 캐시/파서 폴백 0) → 정규 취급으로 집계 유지 (fail-open 방지: 실경기 누락 없음)
const legacy = [game({ homeTeamId: 2, awayTeamId: 1, homeScore: 3, awayScore: 0 })];
check("srId=0 폴백 경기 집계 유지", aggregateMatchups(legacy, 2).total, { wins: 1, losses: 0, draws: 0 });

console.log(`matchup-aggregate smoke: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
