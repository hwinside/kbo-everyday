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

// 삼순 P1 (2026-08-02) — mixed-sign RED: 합성 점수가 긍정인데 근거만 부정이면 사용자가
// 초록 점수 옆에서 나빠진 지표만 보게 된다. 점수 방향을 설명하는 기여 지표가 먼저 나와야 하고,
// 반대 부호 지표가 있으면 함께 노출되어 모순이 보이지 않아야 한다.
const mixedBatter = batterCompatibility({
  playerId: "mixed-b", attendanceAvg: 0.26, seasonAvg: 0.27, deltaAvg: -0.01,
  attendanceHrPerGame: 0.7, seasonHrPerGame: 0.1,
  attendanceRbiPerGame: 1.6, seasonRbiPerGame: 0.6,
  appearances: 10, ab: 40,
});
assert.ok(mixedBatter, "mixed-sign 타자 궁합점수는 산출돼야 함");
if (mixedBatter!.tone === "positive") {
  assert.ok(
    /▲/.test(mixedBatter!.evidence),
    `긍정 궁합점수는 점수를 설명하는 긍정 기여 지표를 보여줘야 함: ${mixedBatter!.evidence}`,
  );
}
assert.ok(
  mixedBatter!.evidence.includes("타율") && /홈런|타점/.test(mixedBatter!.evidence),
  `반대 부호 지표가 있으면 함성 기여 지표와 함께 표기돼야 함: ${mixedBatter!.evidence}`,
);

const mixedPitcher = pitcherCompatibility({
  playerId: "mixed-p", attendanceEra: 4.0, seasonEra: 3.5, eraImprovement: -0.5,
  attendanceK9: 11.5, seasonK9: 8, k9Delta: 3.5, appearances: 6, outs: 60,
});
assert.ok(mixedPitcher, "mixed-sign 투수 궁합점수는 산출돼야 함");
assert.ok(
  mixedPitcher!.evidence.includes("ERA") && mixedPitcher!.evidence.includes("K/9"),
  `투수 mixed-sign 근거는 ERA·K/9를 함께 보여줘야 함: ${mixedPitcher!.evidence}`,
);

// 단일 방향(모두 긍정)이면 근거를 불필요하게 늘리지 않는다.
assert.equal(
  batterScore!.evidence.includes(" · "),
  false,
  `모든 기여가 같은 방향이면 단일 근거만 표기: ${batterScore!.evidence}`,
);

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
metrics.A1.n = 4;
metrics.A1.denominator = { attendanceFinalGames: 4, teamSeasonGames: 36 };
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
// 요정 지수 v2 — 순수 승률이 아니라 5축 합성. 기준점 50 = 평소와 같음.
// A1만 있는 이 fixture 는 winLift 축 하나만 살아남으므로 가중치 재정규화 후 그 축 단독 기여가 된다.
{
  const heroV2 = buildVenueStatsHero(scope);
  assert.equal(heroV2.sampleLimited, false);
  assert.deepEqual(heroV2.attendance, { w: 3, l: 1, d: 0, rate: 0.75 });
  assert.equal(heroV2.teamRate, 20 / 36);
  assert.equal(heroV2.deltaPp, 19.4);
  assert.deepEqual(heroV2.scoreAxes.map((axis) => axis.key), ["winLift"]);
  // deltaPp 19.4%p / 20 = 0.97 축 기여, 신뢰도 4/(4+3)=0.571 → 50 + 50·0.97·0.571 ≈ 78
  assert.equal(heroV2.score, 78, `winLift 단독축 합성 점수: ${heroV2.score}`);
  assert.ok(
    heroV2.scoreConfidence != null && Math.abs(heroV2.scoreConfidence - 4 / 7) < 1e-9,
    "신뢰도는 n/(n+3) 수축",
  );
  assert.notEqual(heroV2.score, 75, "v1 순수 승률(75점)으로 회귀하면 안 됨");
}

// ─ 신뢰도 수축은 실제 직관 분포(대부분 1~4경기)에서 변별력을 가져야 한다.
// 2026-08-02 실측 `venue_attendance` 48명: 1경기 43 · 2경기 4 · 4경기 1(최대 4).
// 구(√(n/20)) 방식은 이 구간을 전부 50점 근처로 므어 지수를 무의미하게 만들었다.
{
  const heroWithGames = (finalGames: number) => {
    const cloned = JSON.parse(JSON.stringify(metrics)) as VenueStatsScopePayload["metrics"];
    cloned.A1.n = finalGames;
    cloned.A1.denominator = { attendanceFinalGames: finalGames, teamSeasonGames: 100 };
    cloned.A1.value = {
      attendance: { w: finalGames, l: 0, d: 0, rate: 1 },
      teamComparable: { teamId: 1, w: 50, l: 50, d: 0, rate: 0.5 },
      // 승률 리프트를 축 끝(+20%p)으로 고정해 신뢰도만 변수로 남긴다.
      deltaPp: 20,
    };
    return buildVenueStatsHero({ ...scope, metrics: cloned });
  };

  const at3 = heroWithGames(3);
  const at5 = heroWithGames(5);
  const at20 = heroWithGames(20);
  // 단조 증가: 같은 리프트면 경기가 쌓일수록 확신에 가까워진다.
  assert.ok(
    at3.score! < at5.score! && at5.score! < at20.score!,
    `신뢰도는 경기수에 대해 단조 증가해야 함: ${at3.score}/${at5.score}/${at20.score}`,
  );
  // 핵심 RED: 최소 표본(3경기)에서도 상한 리프트가 의미 있는 폭으로 나와야 한다.
  // √(3/20)=0.387 → 69점에 그치지만, 3/(3+3)=0.5 → 75점.
  assert.ok(
    at3.score! >= 74,
    `3경기 상한 리프트가 수축에 뭉개지면 안 됨(실제 유저 대부분이 1~4경기): ${at3.score}`,
  );
  assert.ok(
    at3.scoreConfidence != null && Math.abs(at3.scoreConfidence - 0.5) < 1e-9,
    `3경기 신뢰도는 0.5: ${at3.scoreConfidence}`,
  );
}

// ─ 하린아빠 2026-08-02: "이겨도 얼마나 크게, 져도 얼마나 박빙으로"가 긍정 기여하는지.
// 승률은 똑같은데 경기 질만 다른 두 fixture 로 지수 부호가 갈려야 한다.
{
  const withQuality = (qualityAvg: number, extra: Partial<{ closeGames: number; blowoutWins: number }> = {}) => {
    const cloned = JSON.parse(JSON.stringify(metrics)) as VenueStatsScopePayload["metrics"];
    cloned.A1.n = 10;
    cloned.A1.denominator = { attendanceFinalGames: 10, teamSeasonGames: 100 };
    cloned.A1.value = {
      attendance: { w: 5, l: 5, d: 0, rate: 0.5 },
      teamComparable: { teamId: 1, w: 50, l: 50, d: 0, rate: 0.5 },
      deltaPp: 0,
    };
    cloned.D1.state = "ready";
    cloned.D1.n = 10;
    cloned.D1.denominator = { finalGames: 10 };
    cloned.D1.value = {
      avgRunDiff: 0,
      closeGameRate: 0,
      closeGames: extra.closeGames ?? 0,
      qualityAvg,
      closeLosses: 0,
      blowoutWins: extra.blowoutWins ?? 0,
    };
    return buildVenueStatsHero({ ...scope, metrics: cloned });
  };

  // 같은 5승5패(승률 리프트 0)이지만 — 대승+박빙패 조합은 양수, 박빙승+대패는 음수.
  const goodQuality = withQuality(0.5);
  const badQuality = withQuality(-0.5);
  assert.ok(goodQuality.score != null && badQuality.score != null);
  assert.ok(
    goodQuality.score! > 50 && badQuality.score! < 50,
    `승률이 같아도 경기 질로 지수 부호가 갈려야 함: ${goodQuality.score} vs ${badQuality.score}`,
  );
  assert.ok(
    goodQuality.scoreAxes.some((axis) => axis.key === "quality"),
    "경기 질 축이 지수 구성에 들어야 함",
  );

  // 명경기 보너스는 가점 전용 — 박빙패를 많이 본 젠이 더 낮아지면 안 된다.
  const withMemorable = withQuality(0, { closeGames: 6 });
  const withoutMemorable = withQuality(0);
  assert.ok(
    withMemorable.score! >= withoutMemorable.score!,
    `명경기 목격은 감점이 되면 안 됨: ${withMemorable.score} < ${withoutMemorable.score}`,
  );
}

// ─ 표본 미달 계약: 파생 '요정 지수'는 확정값처럼 노출하지 않는다.
// mixed_team 은 표본 가드보다 먼저 판정되므로 state 만으로는 총 2경기가 안 걸린다 (삼순 P0-2).
{
  const mixedMetrics = JSON.parse(JSON.stringify(metrics)) as VenueStatsScopePayload["metrics"];
  mixedMetrics.A1.state = "mixed_team";
  mixedMetrics.A1.n = 2;
  mixedMetrics.A1.denominator = { attendanceFinalGames: 2, teamSeasonGames: 0 };
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

  // 총 final 이 가드를 넘으면 mixed_team 이어도 참고용은 벗어난다.
  // 단, v2 지수는 비교 근거(축)가 하나도 없으면 **순수 승률로 대체하지 않고** null 로 fail-close 한다.
  // (v1 은 여기서 2승 0패 → 100점을 냈고, 그게 "강팀 팬은 자동으로 높음" 문제의 뿌리였다)
  const mixedReady = JSON.parse(JSON.stringify(mixedMetrics)) as VenueStatsScopePayload["metrics"];
  mixedReady.A1.n = 6;
  mixedReady.A1.denominator = { attendanceFinalGames: 6, teamSeasonGames: 0 };
  const readyHero = buildVenueStatsHero({ ...scope, metrics: mixedReady });
  assert.equal(readyHero.sampleLimited, false, "mixed_team 이어도 표본 충족이면 참고용 아님");
  assert.deepEqual(readyHero.scoreAxes, [], "비교 근거가 없으면 축 0개");
  assert.equal(readyHero.score, null, "축이 하나도 없으면 승률(100점)으로 대체하지 않고 fail-close");

  // 팀별 items 에 비교값이 살아 있으면 mixed_team 이어도 경기수 가중 평균으로 축이 생긴다.
  const mixedWithLift = JSON.parse(JSON.stringify(mixedReady)) as VenueStatsScopePayload["metrics"];
  mixedWithLift.A1.items = [
    { key: "1", state: "ready", value: { attendance: { w: 3, l: 0, d: 0, rate: 1 }, teamComparable: null, deltaPp: 10 }, n: 3, denominator: {} },
    { key: "2", state: "ready", value: { attendance: { w: 0, l: 3, d: 0, rate: 0 }, teamComparable: null, deltaPp: -10 }, n: 3, denominator: {} },
  ];
  const mixedLiftHero = buildVenueStatsHero({ ...scope, metrics: mixedWithLift });
  assert.deepEqual(mixedLiftHero.scoreAxes.map((a) => a.key), ["winLift"]);
  assert.equal(mixedLiftHero.score, 50, "대칭 리프트(+10/-10)은 기준점 50으로 수렴");
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

  // 같은 attendance_only 여도 표본을 넘기면 참고용은 벗어난다.
  // 다만 attendance_only 는 정의상 시즌 비교 baseline 이 없으므로 v2 지수는 산출되지 않는다
  // — 승률 100%를 100점으로 치환하는 게 v1 의 핵심 결함이었다.
  const aoReady = JSON.parse(JSON.stringify(aoMetrics)) as VenueStatsScopePayload["metrics"];
  aoReady.A1.n = 8;
  aoReady.A1.denominator = { attendanceFinalGames: 8, teamSeasonGames: 0 };
  const aoReadyHero = buildVenueStatsHero({ ...scope, metrics: aoReady });
  assert.equal(aoReadyHero.sampleLimited, false, "attendance_only 여도 표본 충족이면 참고용 아님");
  assert.equal(aoReadyHero.score, null, "시즌 baseline 없는 attendance_only 는 지수 fail-close");
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
metrics.A1.n = 4;
metrics.A1.denominator = { attendanceFinalGames: 4, teamSeasonGames: 36 };
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
