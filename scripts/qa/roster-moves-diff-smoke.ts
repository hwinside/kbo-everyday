/**
 * 로스터 변동 diff + 준비 게이트 순수 함수 회귀 스모크.
 * 실행: npx tsx scripts/qa/roster-moves-diff-smoke.ts  (npm run qa:roster-moves)
 */
import { parseTeamRegister, diffRoster, type RosterEntry } from "../../src/lib/roster-moves/parse";
import { evaluateReadiness } from "../../src/lib/roster-moves/readiness";

let pass = 0;
let fail = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
  } else {
    fail++;
    console.error(`✗ ${name}\n  got:  ${g}\n  want: ${w}`);
  }
}

const A: RosterEntry = { kboId: "1", name: "가", backNo: "1", position: "투수" };
const B: RosterEntry = { kboId: "2", name: "나", backNo: "2", position: "포수" };
const C: RosterEntry = { kboId: "3", name: "다", backNo: "3", position: "내야수" };

// ① 등록: prev [A,B] → curr [A,B,C] → C 등록
check("등록 1건", diffRoster([A, B], [A, B, C]), [
  { kboPlayerId: "3", playerName: "다", moveType: "register" },
]);

// ② 말소: prev [A,B,C] → curr [A,B] → C 말소
check("말소 1건", diffRoster([A, B, C], [A, B]), [
  { kboPlayerId: "3", playerName: "다", moveType: "deregister" },
]);

// ③ 변동 없음 (등번호/포지션 변경만으로는 이벤트 없음)
check("변동 없음", diffRoster([A, B], [A, { ...B, backNo: "99", position: "외야수" }]), []);

// ④ 첫 실행 baseline: prev null → 이벤트 0
check("첫 실행 baseline", diffRoster(null, [A, B, C]), []);

// ⑤ 동일일 재실행 멱등: 같은 입력 → 같은 결과 (deterministic)
check(
  "재실행 멱등",
  diffRoster([A, B], [A, C]),
  diffRoster([A, B], [A, C]),
);

// ⑥ 준비 완료 게이트 순수 코어
check("준비됨(로스터+에셋)", evaluateReadiness(true, true), true);
check("로스터만 있고 에셋 없음", evaluateReadiness(true, false), false);
check("둘 다 없음", evaluateReadiness(false, false), false);

// ⑦ 파서: 감독/코치 제외, 선수 섹션만 (playerId 링크 추출)
const fixture = `
<table class="tNData"><thead><tr><th>등번호</th><th>감독</th><th>투타유형</th></tr></thead>
<tbody><tr><td>88</td><td><a href="/Record/Retire/Hitter.aspx?playerId=90214">김태형</a></td><td>우투우타</td></tr></tbody></table>
<table class="tNData"><thead><tr><th>등번호</th><th>투수</th><th>투타유형</th></tr></thead>
<tbody><tr><td>15</td><td><a href="/Record/Player/PitcherDetail/Basic.aspx?playerId=51516">김진욱</a></td><td>좌투좌타</td></tr></tbody></table>
<table class="tNData"><thead><tr><th>등번호</th><th>선수명</th><th>포지션</th></tr></thead>
<tbody><tr><td>7</td><td><a href="/x?playerId=99999">변경표선수</a></td><td>내</td></tr></tbody></table>`;
check("파서 감독제외·선수만", parseTeamRegister(fixture), [
  { kboId: "51516", name: "김진욱", backNo: "15", position: "투수" },
]);

console.log(`\nroster-moves smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
