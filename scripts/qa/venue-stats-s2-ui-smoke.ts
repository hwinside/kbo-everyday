import assert from "node:assert/strict";
import { METRIC_IDS, type VenueStatsScopePayload } from "../../src/lib/venue-stats/types";
import {
  buildVenueStatsHero,
  coverageCaption,
  formatAvg,
  formatOuts,
  formatRate,
  formatSigned,
  VENUE_STATS_UI_GROUPS,
} from "../../src/lib/venue-stats/ui";

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
});
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
