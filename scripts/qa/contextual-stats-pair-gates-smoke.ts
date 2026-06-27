/**
 * Smoke for pair selectors in src/lib/contextual-stats/gates.ts.
 *
 * Covers: §5-6 context gates + §5-4 sample thresholds + 페어 한쪽 결측
 * fallback (single-side survives) + 둘 다 결측 → null.
 */

import {
  SAMPLE_THRESHOLDS,
  selectBasesLoadedPair,
  selectRispPair,
  selectTwoOutsPair,
  selectVsHandPair,
} from "@/lib/contextual-stats/gates";
import type {
  GameContext,
  PlayerHandedness,
  SituationTables,
  SplitRow,
} from "@/lib/contextual-stats/types";

const batterRef = { kboId: "B001", name: "테스트 타자" };
const pitcherRef = { kboId: "P001", name: "테스트 투수" };

function row(label: string, AVG: string, AB: number, H = 0, HR = 0): SplitRow {
  return { label, AVG, AB, H, HR, BB: 0, SO: 0 };
}

function ctx(over: Partial<GameContext> = {}): GameContext {
  return {
    gameId: "G",
    inning: 5,
    isTop: true,
    outs: 1,
    balls: 0,
    strikes: 0,
    bases: { first: false, second: false, third: false },
    batterKboId: "B001",
    pitcherKboId: "P001",
    batterName: "테스트 타자",
    pitcherName: "테스트 투수",
    batterIsPinch: false,
    ...over,
  };
}

const batterSit: SituationTables = {
  bases: [
    row("주자없음", "0.280", 100),
    row("2루", "0.310", 40),
    row("3루", "0.290", 20),
    row("만루", "0.400", 10, 4, 1),
  ],
  byHand: [
    row("좌투수", "0.250", 60),
    row("우투수", "0.300", 200),
  ],
  byOuts: [
    row("0아웃", "0.290", 80),
    row("1아웃", "0.270", 90),
    row("2아웃", "0.305", 70),
  ],
};

const pitcherSit: SituationTables = {
  bases: [
    row("주자없음", "0.240", 200),
    row("2루", "0.260", 50),
    row("3루", "0.220", 30),
    row("만루", "0.180", 10, 2),
  ],
  byHand: [
    row("좌타자", "0.270", 80),
    row("우타자", "0.230", 120),
  ],
  byOuts: [
    row("0아웃", "0.260", 90),
    row("1아웃", "0.245", 95),
    row("2아웃", "0.210", 100),
  ],
};

let pass = 0;
let fail = 0;
function expect(cond: boolean, label: string) {
  if (cond) {
    console.log(`✓ ${label}`);
    pass++;
  } else {
    console.log(`✗ ${label}`);
    fail++;
  }
}

// ===== basesLoaded =====
{
  const r = selectBasesLoadedPair(
    batterSit,
    pitcherSit,
    ctx({ bases: { first: true, second: true, third: true } }),
    batterRef,
    pitcherRef,
  );
  expect(!!r && !!r.value.batter && r.value.batter.row.AVG === "0.400", "basesLoaded: 만루 batter 페어 통과");
  expect(!!r && !!r.value.pitcher && r.value.pitcher.row.AVG === "0.180", "basesLoaded: 만루 pitcher 페어 통과");
}
{
  const r = selectBasesLoadedPair(batterSit, pitcherSit, ctx(), batterRef, pitcherRef);
  expect(r === null, "basesLoaded: 만루 아님 → null");
}
{
  // batter만 표본 부족 (만루 행 AB=2)
  const thinBatter: SituationTables = {
    ...batterSit,
    bases: [row("만루", "0.500", 2, 1)],
  };
  const r = selectBasesLoadedPair(
    thinBatter,
    pitcherSit,
    ctx({ bases: { first: true, second: true, third: true } }),
    batterRef,
    pitcherRef,
  );
  expect(!!r && r.value.batter === null && !!r.value.pitcher, "basesLoaded: batter 표본 부족 → pitcher만 살아남음 (single-side)");
}
{
  const blank: SituationTables = { bases: [], byHand: [], byOuts: [] };
  const r = selectBasesLoadedPair(
    blank,
    blank,
    ctx({ bases: { first: true, second: true, third: true } }),
    batterRef,
    pitcherRef,
  );
  expect(r === null, "basesLoaded: 양쪽 결측 → null");
}

// ===== risp =====
{
  const r = selectRispPair(
    batterSit,
    pitcherSit,
    ctx({ bases: { first: false, second: true, third: false } }),
    batterRef,
    pitcherRef,
  );
  // batter: 2루(40)+3루(20)+만루(10) = AB 70, H = (40*.310≈12)+(20*.29≈5.8)+(10*.4=4) ≈ 22-23
  expect(!!r && !!r.value.batter, "risp: 2루 점유 → batter 페어");
  expect(!!r && r.value.pitcher === null, "risp: pitcher RISP는 실제 AB 미확보 → 숨김");
}
{
  const r = selectRispPair(batterSit, pitcherSit, ctx(), batterRef, pitcherRef);
  expect(r === null, "risp: 주자 없음 → null");
}

// ===== twoOuts =====
{
  const r = selectTwoOutsPair(
    batterSit,
    pitcherSit,
    ctx({ outs: 2 }),
    batterRef,
    pitcherRef,
  );
  expect(!!r && !!r.value.batter && r.value.batter.row.AVG === "0.305", "twoOuts: 2OUT batter 페어");
  expect(!!r && !!r.value.pitcher && r.value.pitcher.row.AVG === "0.210", "twoOuts: 2OUT pitcher 페어");
}
{
  const r = selectTwoOutsPair(batterSit, pitcherSit, ctx({ outs: 1 }), batterRef, pitcherRef);
  expect(r === null, "twoOuts: 1아웃 → null");
}

// ===== vsHand =====
const rightHandedBatter: PlayerHandedness = {
  kboId: "B001",
  name: "테스트 타자",
  bat: "right",
  throws: "right",
};
const leftHandedPitcher: PlayerHandedness = {
  kboId: "P001",
  name: "테스트 투수",
  bat: null,
  throws: "left",
};
const switchBatter: PlayerHandedness = {
  kboId: "B002",
  name: "양타",
  bat: "switch",
  throws: "right",
};

{
  // 우타자 × 좌투수: pitcher "vs 우타자" + batter "vs 좌투수"
  const r = selectVsHandPair(
    batterSit,
    pitcherSit,
    rightHandedBatter,
    leftHandedPitcher,
    batterRef,
    pitcherRef,
  );
  expect(!!r && !!r.value.pitcher && r.value.pitcher.opponentSide === "right" && r.value.pitcher.row.AVG === "0.230", "vsHand: 우타자 → pitcher vs 우타자");
  expect(!!r && !!r.value.batter && r.value.batter.opponentSide === "left" && r.value.batter.row.AVG === "0.250", "vsHand: 좌투수 → batter vs 좌투수");
}
{
  // 양타자: 양쪽 모두 skip
  const r = selectVsHandPair(
    batterSit,
    pitcherSit,
    switchBatter,
    leftHandedPitcher,
    { kboId: "B002", name: "양타" },
    pitcherRef,
  );
  expect(r === null || (r.value.batter === null && r.value.pitcher === null), "vsHand: 양타자 → 양쪽 skip → null");
}
{
  // pitcher throws 미상 → batter 측 skip, pitcher 측은 batter.bat으로 매칭
  const pitcherUnknown: PlayerHandedness = {
    kboId: "P001",
    name: "테스트 투수",
    bat: null,
    throws: null,
  };
  const r = selectVsHandPair(
    batterSit,
    pitcherSit,
    rightHandedBatter,
    pitcherUnknown,
    batterRef,
    pitcherRef,
  );
  expect(!!r && r.value.batter === null && !!r.value.pitcher, "vsHand: pitcher throws 미상 → batter side null, pitcher side 살아남음");
}
{
  // 표본 부족 (vsHand 임계 30, 모든 row AB < 30)
  const thinBatter: SituationTables = {
    ...batterSit,
    byHand: [row("좌투수", "0.250", 10), row("우투수", "0.300", 20)],
  };
  const thinPitcher: SituationTables = {
    ...pitcherSit,
    byHand: [row("좌타자", "0.270", 5), row("우타자", "0.230", 25)],
  };
  const r = selectVsHandPair(
    thinBatter,
    thinPitcher,
    rightHandedBatter,
    leftHandedPitcher,
    batterRef,
    pitcherRef,
  );
  expect(r === null, "vsHand: 양쪽 표본 부족 → null");
}

// ===== Thresholds sanity =====
expect(SAMPLE_THRESHOLDS.basesLoaded === 5, "thresholds: basesLoaded=5");
expect(SAMPLE_THRESHOLDS.risp === 10, "thresholds: risp=10");
expect(SAMPLE_THRESHOLDS.vsHand === 30, "thresholds: vsHand=30");
expect(SAMPLE_THRESHOLDS.twoOuts === 20, "thresholds: twoOuts=20");

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
