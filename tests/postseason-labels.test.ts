import assert from "node:assert/strict";
import { test } from "node:test";
import { postseasonGameLabel, summarizeRegularSeasonResults } from "../src/lib/crawler/game-series";
import { isRegularSeasonFinal } from "../src/lib/constants/season";
for (const [id, srId, raw, expected] of [
  ["20251006NCSS0", "4", "WC1", "WC 1차전"],
  ["20251009SSSK0", "3", "준PO1", "준PO 1차전"],
  ["20251018SSHH0", "5", "PO1", "PO 1차전"],
  ["20251026HHLG0", "7", "KS1", "KS 1차전"],
  ["20260729WOLG0", "0", "정규", ""],
]) test(`${id}: source-bound stage and game number`, () => {
  assert.equal(postseasonGameLabel(srId, raw), expected);
});
test("missing or invalid game number is not invented", () => {
  assert.equal(postseasonGameLabel("4"), "WC");
  assert.equal(postseasonGameLabel("4", "WC3"), "WC");
  assert.equal(postseasonGameLabel(undefined, "KS1"), "");
});
test("mixed postseason wins do not inflate regular calendar totals", () => {
  assert.deepEqual(summarizeRegularSeasonResults([
    ...["4","3","5","7"].map(srId => ({ srId, result: "W" as const })),
    { srId: "0", result: "L" }, { srId: "0", result: "D" }, { result: "W" },
  ]), { wins: 0, losses: 1, draws: 1, winRate: 0 });
});
test("final label changes on KST day boundary after confirmed final day", () => {
  assert.equal(isRegularSeasonFinal(new Date("2026-10-12T14:59:59Z")), false);
  assert.equal(isRegularSeasonFinal(new Date("2026-10-12T15:00:00Z")), true);
  assert.equal(isRegularSeasonFinal(new Date("2027-10-13T00:00:00Z")), false);
});

test("conditional scheduled rounds are not promised as guaranteed games", () => {
  assert.match(postseasonGameLabel("4", "WC2", "scheduled"), /필요시/);
  assert.doesNotMatch(postseasonGameLabel("7", "KS4", "scheduled"), /필요시/);
  assert.match(postseasonGameLabel("7", "KS5", "scheduled"), /필요시/);
  assert.doesNotMatch(postseasonGameLabel("7", "KS5", "final"), /필요시/);
});

test("provisional end date never marks regular season final", () => {
  const window = { start: "20260328", end: "20261012", finalized: false };
  const afterEnd = new Date("2026-10-13T00:00:00Z");
  assert.equal(isRegularSeasonFinal(afterEnd, { "2026": window }), false);
  assert.equal(isRegularSeasonFinal(afterEnd, { "2026": { ...window, finalized: true } }), true);
});
