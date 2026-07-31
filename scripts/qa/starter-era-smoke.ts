import assert from "node:assert/strict";
import { lookupPitcherSeasonEra } from "../../src/lib/stats/pitcher-season";

assert.equal(lookupPitcherSeasonEra("76715"), "3.22", "류현진 ERA");
assert.equal(lookupPitcherSeasonEra("50030"), "2.95", "소형준 ERA");
assert.equal(lookupPitcherSeasonEra("missing"), null, "unknown pitcher fails closed");

console.log("starter ERA smoke: ALL assertions PASS");
