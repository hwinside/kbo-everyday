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

import { summaryPostseasonFacts } from "../src/lib/game-summary/postseason-facts";
import { summaryCompetitionInstructions } from "../src/lib/game-summary/competition-context";
import { newsStandingsContext } from "../src/lib/ai/news-standings-context";
import type { KboGame } from "../src/lib/crawler/kbo-api";
const seeds = [{ rank: 4, teamId: 1, name: "LG" }, { rank: 5, teamId: 2, name: "두산" }];
const wc = { gameId: "20261014OBLG0", srId: "4", gameLabel: "WC1", status: "final", awayTeamId: 2, homeTeamId: 1, awayName: "두산", homeName: "LG", awayScore: 1, homeScore: 4 } as KboGame;
for (const draw of [false, true]) test(`WC1 ${draw ? "draw" : "win"} prompt binds LG advancement without counting advantage`, () => {
  const game = { ...wc, awayScore: draw ? 4 : 1 };
  const facts = summaryPostseasonFacts(game, [game], seeds);
  const prompt = summaryCompetitionInstructions("4", facts);
  assert.match(prompt, /LG 준PO 진출 확정, 두산 시즌 종료/);
  assert.match(prompt, draw ? /LG 0승 · 1무/ : /LG 1승 · 0무/);
  assert.doesNotMatch(prompt, /LG 2승/);
});
test("준PO recap uses only results up to the requested game, not later clincher", () => {
  const games = [1, 2, 3].map(n => ({ ...wc, srId: "3", gameLabel: `준PO${n}`, gameId: `202610${16+n}OBLG0` }));
  const early = summaryPostseasonFacts(games[0], games, seeds);
  assert.match(summaryCompetitionInstructions("3", early), /진출·탈락 결과 미확정/);
  assert.doesNotMatch(early!, /LG 3승|진출 확정/);
  const end = summaryPostseasonFacts(games[2], games, seeds);
  assert.match(summaryCompetitionInstructions("3", end), /LG PO 진출 확정, 두산 시즌 종료/);
  assert.match(end!, /LG 3승/);
});
test("missing seeds/results do not fabricate advancement or cumulative result", () => {
  assert.match(summaryPostseasonFacts(wc, [wc], [])!, /미확정/);
  assert.equal(summaryPostseasonFacts({ ...wc, gameLabel: undefined }, [wc], seeds), null);
  const gap = { ...wc, srId: "3", gameLabel: "준PO3" };
  assert.equal(summaryPostseasonFacts(gap, [gap], seeds), null);
});
test("regular prompt is unchanged; news outside regular window cannot treat standings as current race", () => {
  assert.equal(summaryCompetitionInstructions("0", null), "");
  assert.match(newsStandingsContext("2026-08-05", "REGULAR_TABLE"), /REGULAR_TABLE/);
  assert.doesNotMatch(newsStandingsContext("2026-10-14", "STALE_TABLE"), /STALE_TABLE|유일한 근거/);
  assert.match(newsStandingsContext("2026-10-14", "STALE_TABLE"), /고정 시드/);
});
