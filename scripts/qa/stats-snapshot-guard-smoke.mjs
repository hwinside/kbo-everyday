import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validatePitcherSnapshot } from "../lib/stats-snapshot-guard.mjs";

const full = Array.from({ length: 276 }, (_, index) => ({
  kboId: String(50000 + index),
  name: `투수${index + 1}`,
  team: `T${index % 10}`,
}));

assert.doesNotThrow(
  () => validatePitcherSnapshot(full, full.map((row) => ({ ...row }))),
  "complete 276-row rerun stays GREEN",
);

const missingMiddlePage = full.filter((_row, index) => index < 120 || index >= 150);
assert.equal(missingMiddlePage.length, 246);
assert.throws(
  () => validatePitcherSnapshot(full, missingMiddlePage),
  /pitcher_snapshot_partial:previous=276,candidate=246,countDelta=30,missing=30/,
  "276→246 middle-page omission fails closed",
);

const crawler = readFileSync("scripts/crawl-stats.mjs", "utf8");
const guardIndex = crawler.indexOf("validatePitcherSnapshot(previousPitchers, pitchers)");
const firstWriteIndex = crawler.indexOf("writeFileSync(batterPath");
assert.ok(guardIndex >= 0 && firstWriteIndex > guardIndex,
  "snapshot guard runs before every stats/meta write");

console.log("stats snapshot guard smoke: ALL assertions PASS");
