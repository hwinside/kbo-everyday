import assert from "node:assert/strict";
import test from "node:test";
import { widgetResultPitchers } from "../src/lib/widget-result-pitchers";

const final = { status: "final", awayScore: 3, homeScore: 1, winPitcher: " 양현종 ", losePitcher: "원태인" };
test("official decisions, including optional save, are displayed", () => {
  assert.equal(widgetResultPitchers(final), "승 양현종 / 패 원태인");
  assert.equal(widgetResultPitchers({ ...final, savePitcher: "정해영" }), "승 양현종 / 패 원태인 / 세 정해영");
});
test("live, scheduled and cancelled games never expose stale decisions", () => {
  for (const status of ["live", "scheduled", "cancelled"]) {
    assert.equal(widgetResultPitchers({ ...final, status }), "");
  }
});
test("draws and missing scores hide even stale decision names", () => {
  assert.equal(widgetResultPitchers({ ...final, homeScore: 3 }), "");
  assert.equal(widgetResultPitchers({ ...final, awayScore: null }), "");
});
test("old snapshots, missing and placeholder names do not render empty labels", () => {
  assert.equal(widgetResultPitchers({ status: "final", awayScore: 3, homeScore: 1 }), "");
  assert.equal(widgetResultPitchers({ ...final, winPitcher: "  ", losePitcher: "-", savePitcher: "미정" }), "");
  assert.equal(widgetResultPitchers({ ...final, winPitcher: null }), "패 원태인");
});
