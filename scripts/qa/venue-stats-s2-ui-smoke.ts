import assert from "node:assert/strict";
import {
  METRIC_IDS,
  type MetricEnvelope,
  type VenueStatsScopePayload,
} from "../../src/lib/venue-stats/types";
import {
  batterCompatibility,
  buildVenueStatsHero,
  awayFanTag,
  MEASURED_ATTENDANCE_DISTRIBUTION,
  MEASURED_AWAY_DISTRIBUTION,
  SCORE_CONFIDENCE_LABELS,
  SCORE_SCALE,
  scoreBadgeLabel,
  scoreConfidenceLevel,
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
assert.equal(routed.length, 23); // D7(실책) 추가 — 하린아빠 2026-08-02
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
  // pregame 기대치 대비 초과성과 — 요정 지수의 본체(승률 아님).
  excess: { winExcess: 0.28, marginExcess: 1.2, games: 4 },
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
  // 축은 pregame 초과성과 기반 — winLift(승점 초과) + quality(마진 초과).
  assert.deepEqual(heroV2.scoreAxes.map((axis) => axis.key), ["winLift", "quality"]);
  assert.ok(
    heroV2.scoreConfidence != null && Math.abs(heroV2.scoreConfidence - Math.sqrt(4 / 5)) < 1e-9,
    "신뢰도는 √(n/(n+1)) 수축 — 실측 분포(최대 4경기)에 맞춘 낮은 기준",
  );
  // v1 회귀 RED — 승률(W/L/D)은 그대로 두고 pregame 초과성과만 뒤집으면 점수가 반드시 달라져야 한다.
  // `round(rate*100)` 로 되돌리면 두 케이스가 같은 값이 되어 이 assert 가 깨진다.
  const flipped = JSON.parse(JSON.stringify(metrics)) as VenueStatsScopePayload["metrics"];
  (flipped.A1.value as { excess: unknown }).excess =
    { winExcess: -0.28, marginExcess: -1.2, games: 4 };
  const flippedHero = buildVenueStatsHero({ ...scope, metrics: flipped });
  assert.deepEqual(
    flippedHero.attendance,
    heroV2.attendance,
    "대조군은 승/패 기록이 동일해야 한다(초과성과만 다름)",
  );
  assert.ok(
    heroV2.score! > 50 && flippedHero.score! < 50,
    `초과성과 부호가 지수 부호를 결정해야 함(승률 아님): ${heroV2.score} vs ${flippedHero.score}`,
  );
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
      deltaPp: 20,
      // 초과성과를 축 끝으로 고정해 신뢰도만 변수로 남긴다.
      excess: { winExcess: 0.35, marginExcess: 3, games: finalGames },
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
  // 핵심 RED: 최소 표본(3경기)에서도 상한 초과성과가 의미 있는 폭으로 나와야 한다.
  // 하린아빠 2026-08-02(3회 반복): "신뢰도 구간은 경기수 기준을 너무 높게 잡지 마".
  // 실측 분포는 P50 1 · P95 2 · 최대 4경기라 k=3(5경기 해제)은 도달 불가 기준이었다.
  // k=1: 3경기 √(3/4)=.866 → 지수 산출 최소 표본에서 이미 보정이 거의 해제된다.
  assert.ok(
    at3.score! >= 90,
    `3경기 상한 초과성과가 수축에 뭉개지면 안 됨(실측 최대가 4경기): ${at3.score}`,
  );
  assert.ok(
    at3.scoreConfidence != null && Math.abs(at3.scoreConfidence - Math.sqrt(0.75)) < 1e-9,
    `3경기 신뢰도는 √0.75≈0.87: ${at3.scoreConfidence}`,
  );
  // RED — 경기수 기준이 다시 높아지면(k≥2, 즉 3경기 r<0.85) FAIL.
  assert.ok(
    at3.scoreConfidence! >= 0.85,
    `최소 표본 3경기에서 보정이 거의 해제돼야 함(기준 상향 회귀 차단): ${at3.scoreConfidence}`,
  );
  // 3→20경기 이득이 완만해야 한다. k=1 이면 .866 / .976 = 89%.
  assert.ok(
    at3.scoreConfidence! / at20.scoreConfidence! >= 0.88,
    `3→20경기 추가 이득은 완만해야 함: ${at3.scoreConfidence} / ${at20.scoreConfidence}`,
  );
  assert.ok(
    at5.scoreConfidence! >= 0.9,
    `5경기 신뢰도는 .9 이상: ${at5.scoreConfidence}`,
  );
  // 신뢰도 라벨은 점수 반응성(r)과 분리된 제품 정책이다(삼순 지적).
  // 실측 최대가 4경기 → 라벨 임계도 관측된 분포 안에서만 나눈다(3 낮음 · 4 보통 · 5+ 높음).
  assert.equal(scoreConfidenceLevel(2), "measuring");
  assert.equal(scoreConfidenceLevel(3), "low");
  assert.equal(scoreConfidenceLevel(4), "medium");
  assert.equal(scoreConfidenceLevel(5), "high");
  // RED — 라벨 임계가 실측 최대(4경기)를 넘으면 "아무도 도달 못 하는 등급"이 생긴다.
  assert.equal(
    scoreConfidenceLevel(MEASURED_ATTENDANCE_DISTRIBUTION.max),
    "medium",
    "실측 최대 경기수에서 이미 최소 '보통' 이상이어야 함(도달 불가 라벨 차단)",
  );
  assert.notEqual(
    scoreConfidenceLevel(MEASURED_ATTENDANCE_DISTRIBUTION.max + 1),
    "low",
    "실측 최대+1 경기에서 '낮음'이면 기준이 너무 높다",
  );
}

// ─ 하린아빠 2026-08-02: "보통 홈구장만 가는 팬이 대부분인데 원정까지 많이 가는 팬은
//   정말 찐팬이니 이것도 추가". 임계는 실측 분포 안에서 나뉘어야 한다.
{
  assert.equal(awayFanTag({ awayGames: 0, awayStadiums: 0, totalGames: 8 }), null,
    "원정이 없으면 태그를 붙이지 않는다");

  // 실측: 원정 경험자 12/42(29%) · 최대 2경기 · 최대 2구장.
  const first = awayFanTag({ awayGames: 1, awayStadiums: 1, totalGames: 8 })!;
  assert.equal(first.tier, 1);
  assert.equal(first.label, "첫 원정");
  assert.equal(first.value, "원정 1경기", "구장 1곳이면 구장 수를 중복 표기하지 않는다");

  // 관측 최대치(2경기·2구장)에서 최소 3단계 이상 — 도달 불가 등급만 남기지 않는다.
  const atMax = awayFanTag({
    awayGames: MEASURED_AWAY_DISTRIBUTION.maxAwayGames,
    awayStadiums: MEASURED_AWAY_DISTRIBUTION.maxAwayStadiums,
    totalGames: 8,
  })!;
  assert.ok(
    atMax.tier >= 3,
    `실측 최대 원정(${MEASURED_AWAY_DISTRIBUTION.maxAwayGames}경기·${MEASURED_AWAY_DISTRIBUTION.maxAwayStadiums}구장)에서 3단계 이상이어야 함: tier ${atMax.tier}`,
  );
  assert.equal(atMax.label, "전국구 팬");

  // RED — 구 임계(원정 8경기 & 4구장 / 3구장)로 되돌리면 실측 최대에서도 tier 1 에 머문다.
  assert.ok(
    awayFanTag({ awayGames: 2, awayStadiums: 1, totalGames: 8 })!.tier >= 2,
    "관측 최대 원정 경기수(2)는 최소 '원정러' 이상이어야 함(임계 재상향 차단)",
  );

  // 원정 비중이 전체 평균의 1.5배를 넘으면 1경기여도 승급.
  const highShare = awayFanTag({ awayGames: 1, awayStadiums: 1, totalGames: 2 })!;
  assert.equal(highShare.tier, 2, `원정 비중 50%는 '원정러': ${JSON.stringify(highShare)}`);
  // 반대로 비중이 낮으면 승급하지 않는다(과잉 부여 차단).
  assert.equal(awayFanTag({ awayGames: 1, awayStadiums: 1, totalGames: 20 })!.tier, 1);

  // 최상위는 관측 밖 "성장 등급" — 현재 아무도 도달하지 못하는 것이 의도.
  const top = awayFanTag({ awayGames: 3, awayStadiums: 2, totalGames: 12 })!;
  assert.equal(top.label, "원정대장");
  assert.equal(top.tier, 4);
  assert.ok(
    top.tier > atMax.tier,
    "성장 등급은 실측 최대보다 위에 있어야 한다",
  );

  // 단조성 — 원정이 늘수록 등급이 내려가지 않는다.
  let prev = 0;
  for (const [g, st] of [[1, 1], [2, 1], [2, 2], [3, 2], [8, 4]] as const) {
    const tag = awayFanTag({ awayGames: g, awayStadiums: st, totalGames: 20 })!;
    assert.ok(tag.tier >= prev, `원정 ${g}경기·${st}구장에서 등급이 역행함: ${tag.tier} < ${prev}`);
    prev = tag.tier;
  }

  // totalGames 가 0이어도 나눗셈 오염 없이 동작한다.
  assert.equal(awayFanTag({ awayGames: 1, awayStadiums: 1, totalGames: 0 })!.tier, 1);
}

// ─ 하린아빠 2026-08-02: "관전가치 기준이 아니라 무조건 팀퍼포먼스와의 상관도를 봐야지".
// 지수는 오직 pregame 기대치 대비 초과성과다. 승패 기록이 같아도 초과성과로 부호가 갈린다.
{
  const withExcess = (winExcess: number, marginExcess: number) => {
    const cloned = JSON.parse(JSON.stringify(metrics)) as VenueStatsScopePayload["metrics"];
    cloned.A1.n = 10;
    cloned.A1.denominator = { attendanceFinalGames: 10, teamSeasonGames: 100 };
    cloned.A1.value = {
      attendance: { w: 5, l: 5, d: 0, rate: 0.5 },
      teamComparable: { teamId: 1, w: 50, l: 50, d: 0, rate: 0.5 },
      deltaPp: 0,
      excess: { winExcess, marginExcess, games: 10 },
    };
    return buildVenueStatsHero({ ...scope, metrics: cloned });
  };

  // 같은 5승5패인데 — 기대보다 잘했으면 50 위, 못했으면 50 아래.
  const over = withExcess(0.15, 1.5);
  const under = withExcess(-0.15, -1.5);
  assert.ok(
    over.score! > 50 && under.score! < 50,
    `승패가 같아도 기대 대비 성과로 부호가 갈려야 함: ${over.score} vs ${under.score}`,
  );

  // 관전가치 축(경기 질)·명경기 보너스는 제거됐다 — 이중 가산 금지(삼순 P0).
  const axisKeys = over.scoreAxes.map((axis) => axis.key);
  assert.equal(axisKeys.includes("bonus"), false, "명경기 보너스 축은 제거돼야 함");
  assert.deepEqual(
    axisKeys.filter((key) => key === "winLift" || key === "quality"),
    ["winLift", "quality"],
    "초과성과 2축(승리·득실)이 본체",
  );
  // 삼순 확정 가중 — 승패 55% : 득실 30%.
  const byKey = new Map(over.scoreAxes.map((axis) => [axis.key, axis.weight]));
  assert.equal(byKey.get("winLift"), 0.55);
  assert.equal(byKey.get("quality"), 0.3);

  // pregame 기대치가 없으면 축 재정규화가 아니라 지수 전체 fail-close (삼순 P0).
  const noExpectation = JSON.parse(JSON.stringify(metrics)) as VenueStatsScopePayload["metrics"];
  noExpectation.A1.n = 10;
  noExpectation.A1.denominator = { attendanceFinalGames: 10, teamSeasonGames: 100 };
  noExpectation.A1.value = {
    attendance: { w: 9, l: 1, d: 0, rate: 0.9 },
    teamComparable: { teamId: 1, w: 50, l: 50, d: 0, rate: 0.5 },
    deltaPp: 40,
    excess: null,
  };
  const failClosed = buildVenueStatsHero({ ...scope, metrics: noExpectation });
  assert.deepEqual(failClosed.scoreAxes, [], "기대치 없으면 축 0개");
  assert.equal(failClosed.score, null, "기대치 없으면 승률(90%)로 대체하지 않고 fail-close");
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
  // 초과성과는 팀이 섞여도 경기 단위 pregame 기대치 기준이라 전체 합산이 성립한다.
  const mixedWithExcess = JSON.parse(JSON.stringify(mixedReady)) as VenueStatsScopePayload["metrics"];
  (mixedWithExcess.A1.value as { excess: unknown }).excess =
    { winExcess: 0, marginExcess: 0, games: 6 };
  const mixedExcessHero = buildVenueStatsHero({ ...scope, metrics: mixedWithExcess });
  assert.deepEqual(mixedExcessHero.scoreAxes.map((a) => a.key), ["winLift", "quality"]);
  assert.equal(mixedExcessHero.score, 50, "기대와 정확히 같으면 기준점 50");
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
    excess: null,
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

// ─ 삼순 P0 (2026-08-02): 정규화 스케일 `.35/3` 의 제품 계약 잠금 ────────────────
//
// 지적: `.35/3` 을 `.25/2` 로 바꾸면 같은 경기가 71 → 80 점이 되어
// `약간 요정 ↔ 진짜 요정` 배지가 뒤집히는데 어떤 게이트도 그걸 막지 못했다.
// browser sentinel 도 구현 변경에 맞춰 함께 갱신돼 정책을 독립 고정하지 못했다.
//
// holdout 보정이 아니라 **정책 경로**를 택한 이유는 ui.ts SCORE_SCALE 주석 참조.
// 여기서는 두 가지를 잠근다:
//   ① 값 자체 고정 — 무단 재튜닝 차단
//   ② raw-game 민감도 행렬 — 스케일이 바뀌어도 순서·부호·배지 구간이 흔들리지 않는가
{
  // ① 정책 상수 고정. 바꾸려면 이 회귀를 함께 고쳐야 한다(조용한 재튜닝 불가).
  assert.equal(SCORE_SCALE.winExcess, 0.35, "승점 초과 축 끝은 정책 상수 0.35");
  assert.equal(SCORE_SCALE.marginExcess, 3, "마진 초과 축 끝은 정책 상수 3");

  const scoreOf = (winExcess: number, marginExcess: number, games = 10) => {
    const cloned = JSON.parse(JSON.stringify(metrics)) as VenueStatsScopePayload["metrics"];
    cloned.A1.state = "ready";
    cloned.A1.items = undefined;
    cloned.A1.n = games;
    cloned.A1.denominator = { attendanceFinalGames: games, teamSeasonGames: 100 };
    cloned.A1.value = {
      attendance: { w: 5, l: 5, d: 0, rate: 0.5 },
      teamComparable: { teamId: 1, w: 50, l: 50, d: 0, rate: 0.5 },
      deltaPp: 0,
      excess: { winExcess, marginExcess, games },
    };
    return buildVenueStatsHero({ ...scope, metrics: cloned }).score!;
  };

  // ② 민감도 행렬 — 중립·약/강 초과성과·박빙/대승을 한 축에 늘어놓는다.
  //    스케일을 바꿔도 이 **순서와 부호**는 절대 흔들리면 안 된다.
  const matrix = [
    { name: "강한 열세", win: -0.30, margin: -2.5 },
    { name: "약한 열세", win: -0.10, margin: -0.8 },
    { name: "중립", win: 0, margin: 0 },
    { name: "약한 우세", win: 0.10, margin: 0.8 },
    { name: "강한 우세", win: 0.30, margin: 2.5 },
  ];
  const scores = matrix.map((m) => scoreOf(m.win, m.margin));

  // 단조 증가 — 초과성과가 커질수록 점수도 커진다.
  for (let i = 1; i < scores.length; i++) {
    assert.ok(
      scores[i]! > scores[i - 1]!,
      `민감도 순서 역행: ${matrix[i - 1]!.name}(${scores[i - 1]}) → ${matrix[i]!.name}(${scores[i]})`,
    );
  }
  // 부호 — 중립은 정확히 50, 열세는 50 미만, 우세는 50 초과.
  assert.equal(scores[2], 50, `중립(초과성과 0)은 정확히 50이어야 함: ${scores[2]}`);
  assert.ok(scores[0]! < 50 && scores[1]! < 50, "열세는 50 미만");
  assert.ok(scores[3]! > 50 && scores[4]! > 50, "우세는 50 초과");

  // 배지 구간 안정성 — 사용자가 보는 등급이 각 구간에서 서로 달라야 한다.
  // (스케일을 공격적으로 바꾸면 약한 우세까지 `진짜 요정`이 되어 이 assert 가 깨진다.)
  const badges = scores.map(scoreBadgeLabel);
  assert.equal(badges[2], "평소와 비슷", `중립 배지: ${badges[2]}`);
  assert.notEqual(
    badges[3], badges[4],
    `약한 우세(${scores[3]}·${badges[3]})와 강한 우세(${scores[4]}·${badges[4]})가 같은 배지면 변별력이 없다`,
  );
  assert.notEqual(
    badges[0], badges[1],
    `강한 열세(${scores[0]}·${badges[0]})와 약한 열세(${scores[1]}·${badges[1]})가 같은 배지면 변별력이 없다`,
  );
  // 약한 우세가 최상위 배지를 먹으면 스케일이 너무 공격적이다(= `.25/2` 회귀).
  assert.notEqual(
    badges[3], "진짜 요정",
    `약한 우세(win .10 / margin .8)가 최상위 배지면 스케일이 과하다: ${scores[3]}`,
  );
  // 강한 우세가 최상위에 못 가면 너무 보수적이다(= `.5/4` 회귀).
  assert.equal(
    badges[4], "진짜 요정",
    `강한 우세(win .30 / margin 2.5)는 최상위 배지여야 한다: ${scores[4]}`,
  );

  // 축 끝(±1) 포화 — 정책 상수 자체가 축 끝임을 확인한다.
  const atCap = scoreOf(SCORE_SCALE.winExcess, SCORE_SCALE.marginExcess, 20);
  const beyondCap = scoreOf(SCORE_SCALE.winExcess * 2, SCORE_SCALE.marginExcess * 2, 20);
  assert.equal(atCap, beyondCap, "정책 상수가 축 끝이므로 그 이상은 포화(clamp)되어야 함");
}

// ─ 삼순 P1 (2026-08-02): `신뢰도` 라벨이 이용 빈도를 통계 신뢰도로 둔갑시키던 문제 ──
//
// 임계는 실측 이용 빈도(최대 4경기)에서 나왔는데 라벨은 `신뢰도 높음` 이라고 썼다.
// 주석에서 스스로 "백분위는 통계적 신뢰도 근거가 아니다" 라고 해놓고 그렇게 부른 모순.
// holdout 이 없으므로 통계적 신뢰도를 주장하지 않는 이름(`기록 충분도`)으로 바꿨다.
{
  const labels = Object.values(SCORE_CONFIDENCE_LABELS);
  for (const label of labels) {
    assert.ok(
      !label.includes("신뢰도"),
      `이용 빈도 기반 라벨이 통계적 '신뢰도'를 주장하면 안 됨: ${label}`,
    );
  }
  assert.equal(SCORE_CONFIDENCE_LABELS.measuring, "측정 중");
  assert.equal(SCORE_CONFIDENCE_LABELS.low, "기록 적음");
  assert.equal(SCORE_CONFIDENCE_LABELS.medium, "기록 보통");
  assert.equal(SCORE_CONFIDENCE_LABELS.high, "기록 충분");
}

console.log("venue stats S2 UI smoke: PASS (23/23 routing + hero/scope/format contracts)");
