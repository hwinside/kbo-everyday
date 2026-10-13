import assert from "node:assert/strict";
import { test } from "node:test";
import { seasonPredictionsOpen } from "../src/lib/constants/season";
import { renderAppFacts } from "../src/lib/baseball-qa/app-fact-conversation";
import type { GameConversationInput } from "../src/lib/baseball-qa/game-conversation";
import type { KboGame } from "../src/lib/crawler/kbo-api";
import { isVerifiedEmptyNextGameResult, scanNextGame } from "../src/lib/games/next-game-scan";

test("widget empty evidence rejects partial 200 scans and malformed responses", async () => {
  const scan = (fail: boolean) => scanNextGame({
    dates: ["20261014", "20261015"], signal: new AbortController().signal,
    fetchGames: async (date) => {
      if (fail && date === "20261014") throw new Error("upstream timeout");
      return [] as KboGame[];
    }, matches: () => true,
  });
  const partial = await scan(true);
  assert.equal(partial.game, null);
  assert.deepEqual(partial.failedDates, ["20261014"]);
  assert.equal(isVerifiedEmptyNextGameResult(partial), false);
  assert.equal(isVerifiedEmptyNextGameResult(await scan(false)), true);
  for (const invalid of [null, {}, { game: null }, { game: null, failedDates: null }, { game: {}, failedDates: [] }]) {
    assert.equal(isVerifiedEmptyNextGameResult(invalid), false);
  }
});

test("picks close on KST regular season end and unknown seasons stay closed", () => {
  assert.equal(seasonPredictionsOpen(2026, new Date("2026-10-12T14:59:59Z")), true);
  assert.equal(seasonPredictionsOpen(2026, new Date("2026-10-12T15:00:00Z")), false);
  assert.equal(seasonPredictionsOpen(2027, new Date("2027-07-01")), false);
});
const question = "포스트시즌 대진 알려줘";
const plan = { action: "app_facts", appRequest: { kind: "bracket", informationNeed: "postseason_schedule", period: "current", intentSource: "question", intentQuote: question, quote: question }, target: { source: "none", quote: "", teams: [], excludedTeams: [], backgroundTeams: [], stadium: "", excludedStadiums: [] } };
const now = Date.parse("2025-10-27T10:00:00Z");
const base: GameConversationInput = { question, date: "2025-10-27", nowMs: now, favoriteTeam: null, games: [], teamNames: { question: [], context_question: [], profile: [] }, appFacts: { tomorrow: { date: "2025-10-28", games: [] }, standings: null } };
for (const [id, srId, label] of [["20251006NCSS0","4","WC"],["20251009SSSK0","3","준PO"],["20251018SSHH0","5","PO"],["20251026HHLG0","7","KS"]]) {
  test(`bracket uses source facts for ${id}`, () => {
    const game = { gameId: id, srId, gameLabel: `${label}1`, awayName: "원정", homeName: "홈", stadium: "잠실", time: "18:30", status: "scheduled" } as KboGame;
    const input = { ...base, appFacts: { ...base.appFacts!, postseason: { season: 2025, fetchedAt: now, games: [game] } } };
    const result = renderAppFacts(plan, input);
    assert.equal(result?.source, "kbo_structured");
    assert.match(result!.answer, /원정 vs 홈/);
    assert.match(result!.answer, /1차전/);
    assert.match(result!.answer, /조건부 차전/);
    assert.doesNotMatch(result!.answer, /우승 확정/);
  });
}
test("missing, stale and foreign-year brackets cannot fabricate matchups", () => {
  assert.equal(renderAppFacts(plan,base)?.source, "history_hold");
  for (const [season,fetchedAt] of [[2024,now],[2025,now-120001],[2025,now+1]]) {
    assert.equal(renderAppFacts(plan,{...base,appFacts:{...base.appFacts!,postseason:{season,fetchedAt,games:[]}}})?.source,"history_hold");
  }
});

test("regular fixture is never presented as a postseason matchup", () => {
  const regular = { gameId: "20260729WOLG0", srId: "0", awayName: "키움", homeName: "LG", status: "final" } as KboGame;
  const input = { ...base, date: "2026-10-13", appFacts: { ...base.appFacts!, postseason: { season: 2026, fetchedAt: now, games: [regular] } } };
  assert.equal(renderAppFacts(plan,input)?.source,"history_hold");
});

test("range schedule keeps each game's own date and rejects out-of-range responses", async () => {
  const { fetchNaverGames } = await import("../src/lib/crawler/naver-games");
  const original = globalThis.fetch;
  const games = [14,15].map(day => ({ gameId: `444410${day}OBLG02026`, gameDateTime: `2026-10-${day}T18:30:00+09:00`, awayTeamCode: "OB", homeTeamCode: "LG", awayTeamName: "두산", homeTeamName: "LG", statusCode: "READY" }));
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("fromDate"),"2026-10-12");
    assert.equal(url.searchParams.get("toDate"),"2026-11-30");
    return Response.json({code:200,success:true,result:{games}});
  };
  try {
    const rows = await fetchNaverGames("20261012",undefined,{toDate:"20261130"});
    assert.deepEqual(rows.map(g=>g.gameId),["20261014OBLG0","20261015OBLG0"]);
    assert.deepEqual(rows.map(g=>g.srId),["4","4"]);
    games[0].gameDateTime="2026-09-14T18:30:00+09:00";
    await assert.rejects(fetchNaverGames("20261012",undefined,{toDate:"20261130"}),/identity mismatch/);
  } finally { globalThis.fetch=original; }
});
