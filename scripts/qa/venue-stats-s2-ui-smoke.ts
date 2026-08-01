import assert from "node:assert/strict";
import {
  METRIC_IDS,
  type MetricEnvelope,
  type VenueStatsScopePayload,
} from "../../src/lib/venue-stats/types";
import {
  batterCompatibility,
  buildVenueStatsHero,
  coverageCaption,
  formatAvg,
  formatOuts,
  formatRate,
  formatSigned,
  metricTrend,
  pitcherCompatibility,
  splitCells,
  VENUE_STATS_UI_GROUPS,
} from "../../src/lib/venue-stats/ui";

assert.deepEqual(
  metricTrend(0.042, { higherIsBetter: true, digits: 3, trimLeadingZero: true }),
  { tone: "positive", arrow: "▲", label: "+.042" },
);
assert.deepEqual(
  metricTrend(-0.7, { higherIsBetter: false, digits: 2 }),
  { tone: "positive", arrow: "▼", label: "−0.70" },
  "ERA 하락은 ▼지만 긍정 의미색",
);
assert.equal(metricTrend(0.01, { higherIsBetter: true, digits: 2, neutralThreshold: 0.02 }).tone, "neutral");

const batterScore = batterCompatibility({
  playerId: "b1", attendanceAvg: 0.35, seasonAvg: 0.28, deltaAvg: 0.07,
  attendanceHrPerGame: 0.4, seasonHrPerGame: 0.2,
  attendanceRbiPerGame: 1.1, seasonRbiPerGame: 0.6,
  appearances: 8, ab: 32,
});
assert.ok(batterScore && batterScore.score > 50 && batterScore.score <= 100);
assert.equal(batterCompatibility({
  playerId: "small", attendanceAvg: 1, seasonAvg: 0.2, deltaAvg: 0.8,
  attendanceHrPerGame: 1, seasonHrPerGame: 0,
  attendanceRbiPerGame: 4, seasonRbiPerGame: 0,
  appearances: 1, ab: 4,
}), null, "1경기 대폭발은 궁합점수 미산출");
const pitcherScore = pitcherCompatibility({
  playerId: "p1", attendanceEra: 1.5, seasonEra: 3.5, eraImprovement: 2,
  attendanceK9: 10, seasonK9: 8, k9Delta: 2, appearances: 5, outs: 45,
});
assert.ok(pitcherScore && pitcherScore.score > 50 && pitcherScore.score <= 100);

const routed = Object.values(VENUE_STATS_UI_GROUPS).flat();
assert.equal(routed.length, 22);
assert.deepEqual([...new Set(routed)].sort(), [...METRIC_IDS].sort());

const metrics = Object.fromEntries(
  METRIC_IDS.map((id) => [id, {
    id,
    state: "ready",
    value: null,
    n: 0,
    denominator: {},
    coverage: {},
  }]),
) as VenueStatsScopePayload["metrics"];
metrics.A1.value = {
  attendance: { w: 3, l: 1, d: 0, rate: 0.75 },
  teamComparable: { teamId: 1, w: 20, l: 15, d: 1, rate: 20 / 36 },
  deltaPp: 19.4,
};
const scope: VenueStatsScopePayload = {
  state: "ready",
  filter: { scope: "overall", sources: ["story_geofence", "diary_manual"] },
  coverage: {
    attendanceGames: 4,
    finalGames: 4,
    cancelledGames: 0,
    unavailableGames: 0,
    dedupedRows: 0,
    incompleteFinalGames: 0,
    invalidSnapshot: [],
  },
  metrics,
};
assert.deepEqual(buildVenueStatsHero(scope), {
  score: 75,
  attendance: { w: 3, l: 1, d: 0, rate: 0.75 },
  teamRate: 20 / 36,
  deltaPp: 19.4,
  mixedTeam: false,
  teamIds: [1],
  sampleLimited: false,
});

// ─ 표본 미달 계약: 파생 '요정 지수'는 확정값처럼 노출하지 않는다.
// mixed_team 은 표본 가드보다 먼저 판정되므로 state 만으로는 총 2경기가 안 걸린다 (삼순 P0-2).
{
  const mixedMetrics = JSON.parse(JSON.stringify(metrics)) as VenueStatsScopePayload["metrics"];
  mixedMetrics.A1.state = "mixed_team";
  mixedMetrics.A1.n = 2;
  mixedMetrics.A1.value = {
    attendance: { w: 2, l: 0, d: 0, rate: 1 },
    teamComparable: null,
    deltaPp: null,
  };
  mixedMetrics.A1.items = [
    { key: "1", state: "sample_limited", value: null, n: 1, denominator: {} },
    { key: "2", state: "sample_limited", value: null, n: 1, denominator: {} },
  ];
  const mixedHero = buildVenueStatsHero({ ...scope, metrics: mixedMetrics });
  assert.equal(mixedHero.sampleLimited, true, "mixed_team 총 2경기는 참고용 계약 대상");
  assert.equal(mixedHero.score, null, "mixed_team 총 2경기 전승도 요정 지수 100 금지");
  assert.deepEqual(
    mixedHero.attendance,
    { w: 2, l: 0, d: 0, rate: 1 },
    "score 는 비워도 사실 W/L/D 는 유지",
  );

  // 총 final 이 가드를 넘으면 mixed_team 이어도 정상 노출.
  const mixedReady = JSON.parse(JSON.stringify(mixedMetrics)) as VenueStatsScopePayload["metrics"];
  mixedReady.A1.n = 6;
  const readyHero = buildVenueStatsHero({ ...scope, metrics: mixedReady });
  assert.equal(readyHero.sampleLimited, false, "mixed_team 이어도 표본 충족이면 참고용 아님");
  assert.equal(readyHero.score, 100, "표본 충족 mixed_team 은 파생 점수 노출");
}

// ─ attendance_only(비교 소스 없는 2025 등) 2경기도 참고용 계약 대상 (삼순 P0-1).
// 판정 사다리에서 attendance_only 가 sample_limited 보다 먼저 확정되어 표본 미달이 가려졌던 경계.
{
  const aoMetrics = JSON.parse(JSON.stringify(metrics)) as VenueStatsScopePayload["metrics"];
  aoMetrics.A1.state = "attendance_only";
  aoMetrics.A1.n = 2;
  aoMetrics.A1.denominator = { attendanceFinalGames: 2, teamSeasonGames: 0 };
  aoMetrics.A1.value = {
    attendance: { w: 2, l: 0, d: 0, rate: 1 },
    teamComparable: null,
    deltaPp: null,
  };
  aoMetrics.A1.items = [];
  const aoHero = buildVenueStatsHero({ ...scope, metrics: aoMetrics });
  assert.equal(aoHero.sampleLimited, true, "attendance_only 총 2경기는 참고용 계약 대상");
  assert.equal(aoHero.score, null, "attendance_only 2경기 전승도 요정 지수 100 금지");
  assert.deepEqual(
    aoHero.attendance,
    { w: 2, l: 0, d: 0, rate: 1 },
    "attendance_only 에서도 사실 W/L/D 는 그대로",
  );

  // 같은 attendance_only 여도 표본을 넘기면 정상 노출.
  const aoReady = JSON.parse(JSON.stringify(aoMetrics)) as VenueStatsScopePayload["metrics"];
  aoReady.A1.n = 8;
  aoReady.A1.denominator = { attendanceFinalGames: 8, teamSeasonGames: 0 };
  const aoReadyHero = buildVenueStatsHero({ ...scope, metrics: aoReady });
  assert.equal(aoReadyHero.sampleLimited, false, "attendance_only 여도 표본 충족이면 참고용 아님");
  assert.equal(aoReadyHero.score, 100, "표본 충족 attendance_only 는 파생 점수 노출");
}

// ─ A2~A6 스플릿: 표본 미달 cell 은 top-level value 에 없고 items 에만 사실값이 있다 (삼순 P0-2).
// splitCells() 가 items 를 우선해야 "두산전 1승" 같은 실제 기록이 화면에서 안 사라진다.
{
  const productionShape = {
    id: "A2",
    state: "sample_limited",
    value: [],
    n: 2,
    denominator: { finalGames: 2 },
    coverage: {},
    items: [
      { key: "2", state: "sample_limited", value: { opponentTeamId: 2, w: 1, l: 0, d: 0, rate: 1 }, n: 1, denominator: {} },
      { key: "9", state: "sample_limited", value: { opponentTeamId: 9, w: 1, l: 0, d: 0, rate: 1 }, n: 1, denominator: {} },
    ],
  } as unknown as MetricEnvelope;
  const cells = splitCells<{ opponentTeamId: number; w: number }>(productionShape);
  assert.equal(cells.length, 2, "top-level value=[] 여도 items 사실값을 행으로 낸다");
  assert.equal(cells[0].cell.opponentTeamId, 2);
  assert.equal(cells[0].sampleLimited, true, "표본 미달 cell 은 참고용 표기 대상");

  // ready cell 은 참고용 표기 없이 그대로.
  const readyShape = {
    ...productionShape,
    state: "ready",
    items: [{ key: "2", state: "ready", value: { opponentTeamId: 2, w: 3, l: 1, d: 0, rate: 0.75 }, n: 4, denominator: {} }],
  } as unknown as MetricEnvelope;
  const readyCells = splitCells<{ opponentTeamId: number }>(readyShape);
  assert.equal(readyCells.length, 1);
  assert.equal(readyCells[0].sampleLimited, false);

  // items 가 없는 구버전 payload 는 top-level 로 폴백.
  const legacyShape = {
    ...productionShape,
    value: [{ opponentTeamId: 5, w: 2, l: 1, d: 0, rate: 0.667 }],
    items: undefined,
  } as unknown as MetricEnvelope;
  const legacyCells = splitCells<{ opponentTeamId: number }>(legacyShape);
  assert.equal(legacyCells.length, 1, "items 없는 구버전은 top-level 폴백");
  assert.equal(legacyCells[0].cell.opponentTeamId, 5);
}
assert.equal(formatRate(0.75), "75.0%");
assert.equal(formatRate(null), "–");
assert.equal(formatAvg(0.286), ".286");
assert.equal(formatSigned(-0.41, 2), "−0.41");
assert.equal(formatOuts(20), "6 ⅔");
assert.equal(coverageCaption(scope), "직관 4경기 · 종료 4경기 · 기록 확인 완료");

metrics.A1.state = "mixed_team";
metrics.A1.value = {
  attendance: { w: 3, l: 1, d: 0, rate: 0.75 },
  teamComparable: null,
  deltaPp: null,
};
metrics.A1.items = [
  { key: "1", state: "ready", value: null, n: 2, denominator: {}, coverage: {} },
  { key: "9", state: "ready", value: null, n: 2, denominator: {}, coverage: {} },
];
const mixed = buildVenueStatsHero(scope);
assert.equal(mixed.mixedTeam, true);
assert.deepEqual(mixed.teamIds, [1, 9]);

console.log("venue stats S2 UI smoke: PASS (22/22 routing + hero/scope/format contracts)");
