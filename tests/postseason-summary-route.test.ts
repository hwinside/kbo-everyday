import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { summaryPostseasonFacts } from "../src/lib/game-summary/postseason-facts";
import type { KboGame } from "../src/lib/crawler/kbo-api";

const nativeRequire = createRequire(import.meta.url);
const source = readFileSync(resolve("src/app/api/game-summary/route.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const wc = { gameId: "20261014OBLG0", srId: "4", gameLabel: "WC1", status: "final", awayTeamId: 2, homeTeamId: 1, awayName: "두산", homeName: "LG", awayScore: 1, homeScore: 4 } as KboGame;
const seeds = [{ rank: 4, teamId: 1, name: "LG" }, { rank: 5, teamId: 2, name: "두산" }];

async function callRoute(game: KboGame, games: KboGame[], missing = false, narrative?: string, fields: Record<string, unknown> = {}) {
  const calls = { standings: 0, series: 0, facts: 0, generated: 0 };
  const prompts: string[] = [];
  const facts = summaryPostseasonFacts(game, games, seeds);
  const box = { awayBatters: [], homeBatters: [], awayPitchers: [], homePitchers: [] };
  const lines = { status: "final", away: { R: game.awayScore, innings: [game.awayScore,0,0,0,0,0,0,0,0] }, home: { R: game.homeScore, innings: [game.homeScore,0,0,0,0,0,0,0,null] } };
  const st = [{ teamId: 2, teamName: "두산", ranking: 5 }, { teamId: 1, teamName: "LG", ranking: 4 }].map(x => ({ ...x, wins: 70, losses: 60, winRate: 0.54, gamesBehind: 10 }));
  const dbQuery = { select: () => dbQuery, eq: () => dbQuery, maybeSingle: async () => ({ data: null }) };
  const mocks: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (value: unknown, init?: ResponseInit) => Response.json(value, init) }, after: () => {} },
    "@/lib/supabase/admin": { supabaseAdmin: { from: () => dbQuery, rpc: async (name: string) => ({ data: name.startsWith("claim") ? 1 : true }) } },
    "@/lib/constants/teams": { TEAMS: [{ id: 1, shortName: "LG" }, { id: 2, shortName: "두산" }], isAllStarGameId: () => false },
    "@/lib/crawler/kbo-api": {
      fetchGames: async () => [game], fetchBoxScore: async () => box, fetchGameLinescore: async () => lines,
      fetchStandings: async () => { calls.standings++; return st; }, buildRankMap: () => new Map([[1, 4], [2, 5]]),
    },
    "@/lib/crawler/naver-record": { hasInningBreakdown: () => true },
    "@/lib/crawler/resolve-game-series": { resolveGameSeries: async () => game.srId },
    "@/lib/monitoring/api-fallback-tracker": { trackApiDegradation: async () => {} },
    "@/lib/series/snapshot": { computeSeriesSnapshot: async () => { calls.series++; return { seriesStatus: "in_progress" }; }, serializeSeriesSnapshot: () => "REGULAR_SERIES_SENTINEL" },
    "@/lib/game-summary/postseason-facts": { loadSummaryPostseasonFacts: async () => { calls.facts++; if (missing) throw Error("upstream unavailable"); return facts; } },
  };
  const routeModule = { exports: {} as { POST: (req: unknown) => Promise<Response> } };
  vm.runInNewContext(compiled, {
    module: routeModule, exports: routeModule.exports, console, structuredClone, AbortSignal, URLSearchParams,
    process: { env: { GEMINI_API_KEY: "fixture-only" } },
    require: (id: string) => mocks[id] ?? nativeRequire(id.startsWith("@/") ? resolve("src", id.slice(2)) : id),
    fetch: async (_url: string, init: RequestInit) => {
      calls.generated++;
      prompts.push(JSON.parse(String(init.body)).contents[0].parts[0].text);
      const draw = game.awayScore === game.homeScore;
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ headline: draw ? "LG와 두산 무승부" : "LG, 두산에 승리", winner: draw ? "무승부" : "LG", insight: narrative ?? "안정적인 투구가 돋보였다.", standingsImpact: "stale", seriesContext: "stale", ...fields }) }] } }] });
    },
  });
  const response = await routeModule.exports.POST({ json: async () => ({ gameId: game.gameId }) });
  return { calls, prompts, status: response.status, body: await response.json() };
}

for (const draw of [false, true]) test(`POST WC ${draw ? "draw" : "win"}: no regular inputs, canonical advancement reaches prompt and response`, async () => {
  const game = { ...wc, awayScore: draw ? 4 : 1 };
  const result = await callRoute(game, [game]);
  assert.equal(result.status, 200);
  assert.equal(result.calls.standings, 0); assert.equal(result.calls.series, 0);
  assert.match(result.prompts[0], /LG 준PO 진출 확정, 두산 시즌 종료/);
  assert.match(result.body.summary.seriesContext, /LG 준PO 진출 확정/);
  assert.equal(result.body.summary.standingsImpact, null);
});
test("POST 준PO in-progress versus series complete is bound to game cutoff", async () => {
  const games = [1, 2, 3].map(n => ({ ...wc, srId: "3", gameLabel: `준PO${n}`, gameId: `202610${16+n}OBLG0` }));
  for (const index of [0, 2]) {
    const result = await callRoute(games[index], games);
    assert.equal(result.status, 200);
    assert.match(result.prompts[0], index === 0 ? /진출·탈락 결과 미확정/ : /LG PO 진출 확정/);
    assert.equal(result.calls.series + result.calls.standings, 0);
  }
});
test("POST regular preserves standings and series inputs", async () => {
  const game = { ...wc, srId: "0", gameId: "20260805OBLG0" };
  const result = await callRoute(game, [game]);
  assert.equal(result.status, 200);
  assert.equal(result.calls.series, 1); assert.equal(result.calls.standings, 1); assert.equal(result.calls.facts, 0);
  assert.match(result.prompts[0], /REGULAR_SERIES_SENTINEL/);
  assert.match(result.prompts[0], /LG: 4위/);
});
test("POST ladder outage keeps recap and falls back to stage only", async () => {
  const result = await callRoute(wc, [wc], true);
  assert.equal(result.status, 200);
  assert.equal(result.body.summary.seriesContext, "와일드카드 결정전 경기입니다.");
  assert.match(result.prompts[0], /래더 사실 조회 불가/);
  assert.equal(result.calls.series + result.calls.standings, 0);
});
test("POST accepts evidenced qualification but rejects contradictory winner", async () => {
  const good = await callRoute(wc, [wc], false, "LG는 준PO 진출을 확정했다.");
  assert.equal(good.status, 200);
  assert.equal(good.calls.generated, 1);
  const bad = await callRoute(wc, [wc], false, "두산 준PO 진출 확정.");
  assert.equal(bad.status, 200);
  assert.equal(bad.body.summary.insight, "");
  assert.match(bad.body.summary.seriesContext, /LG 준PO 진출 확정/);
  assert.equal(bad.calls.generated, 2);
});

for (const narrative of [
  "두산 꺾고 준플레이오프 진출 확정",
  "LG는 두산을 꺾고 준플레이오프 진출을 확정했다.",
  "다음 라운드에 진출하며",
  "준플레이오프 진출에 크게 기여",
]) test(`POST real Gemini paraphrase: ${narrative}`, async () => {
  const result = await callRoute(wc, [wc], false, narrative);
  assert.equal(result.status, 200);
  assert.equal(result.calls.generated, 1);
  assert.equal(result.body.summary.insight, narrative);
});
test("POST final attempt removes only offending sentence, preserving nested analysis and facts", async () => {
  const result = await callRoute(wc, [wc], false, "안정적인 투구가 돋보였다. 두산 준PO 진출 확정. LG 타선이 활약했다.");
  assert.equal(result.status, 200);
  assert.equal(result.calls.generated, 2);
  assert.match(result.body.summary.insight, /안정적인 투구/);
  assert.match(result.body.summary.insight, /LG 타선/);
  assert.doesNotMatch(result.body.summary.insight, /두산 준PO/);
});
test("POST unconfirmed advancement is removed after retries, recap remains available", async () => {
  const game = { ...wc, srId: "3", gameLabel: "준PO1" };
  const result = await callRoute(game, [game], false, "LG는 플레이오프 진출을 확정했다. 투수진이 활약했다.");
  assert.equal(result.status, 200);
  assert.equal(result.calls.generated, 2);
  assert.equal(result.body.summary.insight, "투수진이 활약했다.");
  assert.match(result.body.summary.seriesContext, /미확정/);
});

test("POST sanitizes nested sentences and supplies a score headline if the entire title violates facts", async () => {
  const result = await callRoute(wc, [wc], false, undefined, {
    headline: "두산 준PO 진출 확정",
    gameFlow: { late: "투수진이 활약했다. 두산 준PO 진출 확정. 평균자책점 0.50의 호투였다." },
  });
  assert.equal(result.status, 200);
  assert.equal(result.calls.generated, 2);
  assert.match(result.body.summary.headline, /1 - 4/);
  assert.equal(result.body.summary.gameFlow.late, "투수진이 활약했다. 평균자책점 0.50의 호투였다.");
});
