import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolvePlayerIdentity } from "../../src/lib/utils/resolve-player";
import { resolveCelebrationPlayerId } from "../../src/lib/utils/celebration-player";
import roster from "../../src/lib/constants/players-roster.json";
import type { RosterPlayer } from "../../src/types/api";

const players = roster as RosterPlayer[];
for (const fixture of [players, [...players].reverse()]) {
  assert.equal(resolveCelebrationPlayerId("김민준", 4, "strikeout", fixture), "56840");
  for (const event of ["hit", "homerun", "double", "triple", "walk"] as const) {
    assert.equal(resolveCelebrationPlayerId("김민준", 4, event, fixture), "53893");
  }
}
// Exercise a real cross-team fallback, not an ambiguous-name early rejection.
const uniquePitcher = players.find(p => p.position === "투수" &&
  players.filter(other => other.name === p.name).length === 1)!;
assert.ok(uniquePitcher, "fixture needs a uniquely named pitcher");
const otherTeamId = players.find(p => p.teamId !== uniquePitcher.teamId)!.teamId;
assert.equal(resolvePlayerIdentity({ name: uniquePitcher.name, teamId: otherTeamId,
  positionHint: "투수" }, players)?.kboId, uniquePitcher.kboId,
  "precondition: shared resolver does cross-team fallback");
assert.equal(resolveCelebrationPlayerId(uniquePitcher.name, otherTeamId, "strikeout", players), undefined);
const hook = readFileSync(new URL("../../src/lib/hooks/useCelebration.ts", import.meta.url), "utf8");
assert.match(hook, /resolveCelebrationPlayerId\(playerName, relevantTeamId, celebType\)/,
  "live hook must use the event-role identity resolver");
assert.doesNotMatch(hook, /findKboId/);
const pitcher = players.find(p => p.kboId === "56840")!;
const ambiguous = [...players, { ...pitcher, kboId: "test-duplicate" }];
assert.equal(resolveCelebrationPlayerId("김민준", 4, "strikeout", ambiguous), undefined);
assert.equal(resolveCelebrationPlayerId("김민준", 1, "strikeout"), undefined);
assert.equal(resolveCelebrationPlayerId(undefined, 4, "strikeout"), undefined);
assert.equal(resolveCelebrationPlayerId("없는선수", 4, "hit"), undefined);
assert.equal(resolveCelebrationPlayerId("김민준", 4, "victory"), undefined);
assert.equal(resolveCelebrationPlayerId("김민준", 4, "hit", [pitcher]), undefined);
console.log("PASS: celebration identity — role, order, ambiguity, missing and mismatch cases");
