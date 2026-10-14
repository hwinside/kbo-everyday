import assert from "node:assert/strict";
import { guardPreviewContext, previewPostseasonFacts, previewSeriesInstructions, previewVersion } from "../../src/lib/ai/preview-series-policy";

// Captures the production WC1 failure; both old cache and generated JSON use this guard.
const bad = { seriesContext: "2연전 중 첫 경기. 시즌 막판 순위 싸움", standingsImpact: "4위 추격의 불씨", prediction: "LG 58%", awayWinPct: 42 };
for (const srId of ["3", "4", "5", "7", undefined, "invalid"]) {
  const result = guardPreviewContext(bad, srId);
  assert.equal(result.seriesContext, null);
  assert.equal(result.standingsImpact, null);
  assert.equal(result.prediction, bad.prediction);
  assert.equal(result.awayWinPct, 42);
  assert.equal(bad.seriesContext, "2연전 중 첫 경기. 시즌 막판 순위 싸움", "must not mutate shared cache");
}
for (const srId of ["0", "1"]) {
  assert.strictEqual(guardPreviewContext(bad, srId), bad);
  assert.equal(previewVersion(srId), 8, "no mass invalidation of regular-season cache");
  assert.equal(previewSeriesInstructions(srId), "");
}
for (const srId of ["3", "4", "5", "7"]) {
  assert.equal(previewVersion(srId), 9);
  assert.match(previewSeriesInstructions(srId), /반드시 null/);
}
assert.match(previewSeriesInstructions("4"), /1승 또는 1무승부/);
assert.match(previewSeriesInstructions("4"), /두 경기 모두/);
assert.match(previewSeriesInstructions("3"), /5전 3선승/);
assert.match(previewSeriesInstructions("5"), /5전 3선승/);
assert.match(previewSeriesInstructions("7"), /7전 4선승/);
assert.doesNotMatch(previewSeriesInstructions(undefined), /와일드카드/);

const seeds = [{ rank: 1, teamId: 3, name: "KT" }, { rank: 2, teamId: 8, name: "삼성" }, { rank: 3, teamId: 6, name: "KIA" }, { rank: 4, teamId: 1, name: "LG" }, { rank: 5, teamId: 2, name: "두산" }];
const game = { srId: "4", gameLabel: "WC1", status: "scheduled" as const, awayTeamId: 2, homeTeamId: 1 };
const facts = previewPostseasonFacts(game, seeds);
assert.match(facts, /LG: 1승 어드밴티지/);
assert.match(facts, /두산: 와일드카드 두 경기 모두 승리/);
assert.match(facts, /WC 1차전/);
assert.equal(previewPostseasonFacts({ ...game, awayTeamId: 1, homeTeamId: 2 }, seeds), facts, "seed facts must not depend on home/away");
assert.doesNotMatch(previewPostseasonFacts(game, []), /LG|두산/);
assert.doesNotMatch(previewPostseasonFacts({ ...game, homeTeamId: 3 }, seeds), /LG: 1승/);
assert.doesNotMatch(previewPostseasonFacts(game, [...seeds.slice(0, 4), seeds[3]]), /LG: 1승/);
assert.equal(previewPostseasonFacts({ ...game, srId: "0" }, seeds), "");
console.log("postseason preview policy PASS");
