/**
 * 로테이션 예측 엔진 회귀 스모크 (npm run qa:rotation)
 * 결정적 fixture로 slot 회귀/게이트/공식예고 우선을 검증.
 */
import { forecastTeam, forecastAll, detectCycleLen } from "@/lib/rotation/forecast";
import type { KboGame } from "@/lib/crawler/kbo-api";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

function mk(p: Partial<KboGame> & { gameId: string; date: string; awayTeamId: number; homeTeamId: number; status: KboGame["status"] }): KboGame {
  return {
    time: "18:30", stadium: "", awayName: "", homeName: "",
    awayScore: null, homeScore: null, inning: 0, isTop: true,
    awayStarterName: "", homeStarterName: "",
    winPitcher: "", losePitcher: "", savePitcher: "",
    strikes: 0, balls: 0, outs: 0,
    runnersOn: { first: false, second: false, third: false },
    currentPitcher: "", currentBatter: "", awayRank: 0, homeRank: 0,
    ...p,
  };
}

// 팀1(home) 깨끗한 5인 로테이션 A,B,C,D,E ×2, 이후 예정 3경기(선발 미공시)
const ROT = ["A", "B", "C", "D", "E"];
const games: KboGame[] = [];
let day = 1;
for (let i = 0; i < 10; i++) {
  const dd = day.toString().padStart(2, "0");
  games.push(mk({ gameId: `202606${dd}HT1${i}`, date: `202606${dd}`, awayTeamId: 9, homeTeamId: 1, status: "final", homeStarterName: ROT[i % 5] }));
  day++;
}
// 미공시 예정 3경기
for (let k = 0; k < 3; k++) {
  games.push(mk({ gameId: `future-${k}`, date: `2026062${k}`, awayTeamId: 9, homeTeamId: 1, status: "scheduled" }));
}

// 1) cycle 감지 = 5
check("detectCycleLen = 5", detectCycleLen(ROT.concat(ROT)) === 5);

// 2) slot 회귀: ...E 다음 → A, B, C
const f = forecastTeam(games, 1);
const preds = [...f.byGameId.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(e => e[1]);
check("예측 3건 생성", f.byGameId.size === 3);
check("예측 순서 = A,B,C", preds.join(",") === "A,B,C");

// 3) 게이트: history < 5 → 예측 0
const few: KboGame[] = [];
for (let i = 0; i < 3; i++) few.push(mk({ gameId: `g${i}`, date: `2026060${i + 1}`, awayTeamId: 9, homeTeamId: 1, status: "final", homeStarterName: ROT[i] }));
few.push(mk({ gameId: "fut", date: "20260610", awayTeamId: 9, homeTeamId: 1, status: "scheduled" }));
check("history<5 → 예측 없음", forecastTeam(few, 1).byGameId.size === 0);

// 4) 공식 예고는 덮지 않음 + 정렬 보정
const withOfficial = games.slice(0, 10);
withOfficial.push(mk({ gameId: "off-1", date: "20260620", awayTeamId: 9, homeTeamId: 1, status: "scheduled", homeStarterName: "A" })); // 공식 A
withOfficial.push(mk({ gameId: "off-2", date: "20260621", awayTeamId: 9, homeTeamId: 1, status: "scheduled" })); // 예측
const f2 = forecastTeam(withOfficial, 1);
check("공식 예고 경기는 예측 미부여", !f2.byGameId.has("off-1"));
check("공식(A) 다음 예측 = B", f2.byGameId.get("off-2") === "B");

// 5) forecastAll: gameId별 home 슬롯 매핑
const all = forecastAll(games);
check("forecastAll 미래경기 homeStarter 채움", all.get("future-0")?.homeStarter === "A");

console.log(`\n로테이션 예측 스모크: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exit(1);
