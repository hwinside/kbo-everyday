import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  lookupPitcherSeasonEra,
  normalizePitcherEra,
  resolveStarterPitcher,
} from "../../src/lib/stats/pitcher-season";
import { resolveRosterPlayer } from "../../src/lib/utils/player-roster";

const todayStarters = [
  ["류현진", 9, "76715", "3.41"],
  ["소형준", 3, "50030", "3.10"],
  ["양현종", 6, "77637", "4.52"],
  ["토다", 5, "AQ006", "5.23"],
  ["송승기", 1, "51111", "5.49"],
  ["잭로그", 2, "55239", "4.02"],
  ["김건우", 4, "51867", "6.43"],
  ["박준현", 10, "56318", "4.99"],
  ["원태인", 8, "69446", "4.14"],
  ["김진욱", 7, "51516", "3.13"],
] as const;

for (const [name, teamId, kboId, era] of todayStarters) {
  assert.deepEqual(
    resolveStarterPitcher(name, teamId, "-"),
    { name, era, kboId },
    `${name} placeholder box ERA falls back to season`,
  );
}

const officialLineupStarters = [
  ["카라스코", 1, "56103", "0.00"],
  ["곽빈", 2, "68220", "2.64"],
  ["짐머맨", 9, "56799", "0.00"],
  ["배제성", 3, "65516", "4.30"],
  ["타케다", 4, "56823", "7.10"],
  ["김윤하", 10, "54319", "6.35"],
] as const;

for (const [name, teamId, kboId, era] of officialLineupStarters) {
  assert.deepEqual(
    resolveStarterPitcher(name, teamId),
    { name, era, kboId },
    `${name} official pregame lineup resolves season ERA without box score`,
  );
}

assert.equal(lookupPitcherSeasonEra("missing"), null, "unknown pitcher fails closed");

assert.equal(resolveRosterPlayer({ name: "토다", teamId: 5 })?.kboId, "AQ006");
assert.equal(
  lookupPitcherSeasonEra(resolveRosterPlayer({ name: "양현종", teamId: 6 })?.kboId),
  "4.52",
  "동명이인 양현종은 KIA 정본으로 해석",
);
assert.equal(normalizePitcherEra("-"), null, "placeholder ERA rejected");
assert.equal(normalizePitcherEra("N/A"), null, "non-numeric ERA rejected");
assert.equal(normalizePitcherEra("0.00"), "0.00", "finite ERA accepted");
assert.equal(
  resolveStarterPitcher("곽빈", 2, "9.99", "다른투수").era,
  "2.64",
  "box ERA from a different identity cannot contaminate the starter",
);
assert.equal(
  resolveStarterPitcher("곽빈", 2, "2.66", "곽빈").era,
  "2.66",
  "matching in-game box ERA takes priority over season fallback",
);
assert.equal(
  resolveStarterPitcher("양현종", 1).era,
  "-",
  "same-name or stale stats from another team fail closed",
);
assert.equal(
  resolveStarterPitcher("배제성", 3, undefined, undefined).era,
  "4.30",
  "partial or unavailable box stats retain the identity-bound season fallback",
);
assert.deepEqual(
  resolveStarterPitcher("미등록투수", 1, "-"),
  { name: "미등록투수", era: "-", kboId: undefined },
  "unknown pitcher fails closed without guessing",
);

const gamePage = readFileSync("src/app/(main)/games/[gameId]/page.tsx", "utf8");
assert.equal(
  (gamePage.match(/resolveStarterPitcher\([\s\S]*?validBoxName,\n\s*\);/g) ?? []).length,
  2,
  "both official-lineup sides must bind box ERA to the actual box pitcher identity",
);
assert.ok(
  gamePage.includes("startingPitcher: resolveStarterPitcher(awayName, game.awayTeamId)")
    && gamePage.includes("startingPitcher: resolveStarterPitcher(homeName, game.homeTeamId)"),
  "starter-only pregame UI must use the identity-bound season fallback",
);

console.log("starter ERA smoke: ALL assertions PASS");
