import assert from "node:assert/strict";
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
const pitcher = players.find(p => p.kboId === "56840")!;
const ambiguous = [...players, { ...pitcher, kboId: "test-duplicate" }];
assert.equal(resolveCelebrationPlayerId("김민준", 4, "strikeout", ambiguous), undefined);
assert.equal(resolveCelebrationPlayerId("김민준", 1, "strikeout"), undefined);
assert.equal(resolveCelebrationPlayerId(undefined, 4, "strikeout"), undefined);
assert.equal(resolveCelebrationPlayerId("없는선수", 4, "hit"), undefined);
assert.equal(resolveCelebrationPlayerId("김민준", 4, "victory"), undefined);
assert.equal(resolveCelebrationPlayerId("김민준", 4, "hit", [pitcher]), undefined);
console.log("PASS: celebration identity — role, order, ambiguity, missing and mismatch cases");
