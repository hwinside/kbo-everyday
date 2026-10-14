import assert from "node:assert/strict";
import { test } from "node:test";
import { summaryCompetitionPolicy, invalidPostseasonNarrative } from "../src/lib/game-summary/competition-context";

test("WC/준PO/PO/KS never use regular standings or consecutive-series context", () => {
  for (const id of ["4", "3", "5", "7"]) {
    const policy = summaryCompetitionPolicy(id);
    assert.equal(policy.regular, false);
    assert.ok(policy.label);
    assert.match(policy.instructions, /standingsImpact와 seriesContext는 null/);
  }
  assert.equal(summaryCompetitionPolicy("0").regular, true);
  assert.equal(summaryCompetitionPolicy("0").instructions, "");
  assert.equal(summaryCompetitionPolicy("unknown").regular, false);
});

test("reported WC ranking narrative and unsupported qualification claims are rejected", () => {
  for (const text of [
    "LG는 이번 승리로 4위 자리를 더욱 굳건히 하는 데 중요한 발판을 마련했다.",
    "두산과의 승차를 벌리며 순위 경쟁에서 유리한 고지를 점했다.",
    "LG는 이번 시리즈를 1승 0패로 마쳤다.",
    "준PO 진출을 확정했다.", "한국시리즈 우승을 차지했다.",
  ]) assert.equal(invalidPostseasonNarrative({ insight: text }), true, text);
});

test("game facts remain available, including nested turning-point narrative", () => {
  assert.equal(invalidPostseasonNarrative({ headline: "LG, 두산에 4-1 승리", insight: "오스틴은 8회 2점 홈런을 기록했다." }), false);
  assert.equal(invalidPostseasonNarrative({ gameFlow: { turningPoint: "승차를 벌렸다" } }), true);
  assert.equal(invalidPostseasonNarrative({ seriesContext: "와일드카드 결정전 경기입니다.", standingsImpact: null }), false);
});
