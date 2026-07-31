import assert from "node:assert/strict";
import {
  lookupPitcherSeasonEra,
  normalizePitcherEra,
  resolveStarterPitcher,
} from "../../src/lib/stats/pitcher-season";
import { resolveRosterPlayer } from "../../src/lib/utils/player-roster";

const todayStarters = [
  ["류현진", 9, "76715", "3.22"],
  ["소형준", 3, "50030", "2.95"],
  ["양현종", 6, "77637", "3.87"],
  ["토다", 5, "AQ006", "5.38"],
  ["송승기", 1, "51111", "5.50"],
  ["잭로그", 2, "55239", "4.17"],
  ["김건우", 4, "51867", "6.32"],
  ["박준현", 10, "56318", "4.61"],
  ["원태인", 8, "69446", "3.84"],
  ["김진욱", 7, "51516", "3.19"],
] as const;

for (const [name, teamId, kboId, era] of todayStarters) {
  assert.deepEqual(
    resolveStarterPitcher(name, teamId, "-"),
    { name, era, kboId },
    `${name} placeholder box ERA falls back to season`,
  );
}

assert.equal(lookupPitcherSeasonEra("missing"), null, "unknown pitcher fails closed");

assert.equal(resolveRosterPlayer({ name: "토다", teamId: 5 })?.kboId, "AQ006");
assert.equal(
  lookupPitcherSeasonEra(resolveRosterPlayer({ name: "양현종", teamId: 6 })?.kboId),
  "3.87",
  "동명이인 양현종은 KIA 정본으로 해석",
);
assert.equal(normalizePitcherEra("-"), null, "placeholder ERA rejected");
assert.equal(normalizePitcherEra("N/A"), null, "non-numeric ERA rejected");
assert.equal(normalizePitcherEra("0.00"), "0.00", "finite ERA accepted");
assert.deepEqual(
  resolveStarterPitcher("미등록투수", 1, "-"),
  { name: "미등록투수", era: "-", kboId: undefined },
  "unknown pitcher fails closed without guessing",
);

console.log("starter ERA smoke: ALL assertions PASS");
