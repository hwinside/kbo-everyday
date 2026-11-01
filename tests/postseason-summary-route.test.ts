import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { summaryPostseasonFacts } from "../src/lib/game-summary/postseason-facts";
import type { KboGame } from "../src/lib/crawler/kbo-api";

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://summary-route.test';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-only';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';
const nativeRequire = createRequire(import.meta.url);
const source = readFileSync(resolve("src/app/api/game-summary/route.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const wc = { gameId: "20261014OBLG0", srId: "4", gameLabel: "WC1", status: "final", awayTeamId: 2, homeTeamId: 1, awayName: "두산", homeName: "LG", awayScore: 1, homeScore: 4 } as KboGame;
const seeds = [{ rank: 4, teamId: 1, name: "LG" }, { rank: 5, teamId: 2, name: "두산" }];

async function callRoute(game: KboGame, games: KboGame[], missing = false, narrative?: string, fields: Record<string, unknown> = {}, failure?: "model" | "roster-score" | "save", retryRecord = false) {
  const calls = { standings: 0, series: 0, facts: 0, generated: 0 };
  const prompts: string[] = [];
  const facts = summaryPostseasonFacts(game, games, seeds);
  const box = { awayBatters: [], homeBatters: [], awayPitchers: [], homePitchers: [] };
  const lines = { status: "final", away: { R: game.awayScore, innings: [game.awayScore,0,0,0,0,0,0,0,0] }, home: { R: game.homeScore, innings: [game.homeScore,0,0,0,0,0,0,0,null] } };
  const st = [{ teamId: 2, teamName: "두산", ranking: 5 }, { teamId: 1, teamName: "LG", ranking: 4 }].map(x => ({ ...x, wins: 70, losses: 60, winRate: 0.54, gamesBehind: 10 }));
  let cachedSummary: Record<string, unknown> | null = null;
  const dbQuery = { select: () => dbQuery, eq: () => dbQuery, maybeSingle: async () => ({ data: cachedSummary ? { summary:cachedSummary, prompt_version:16 } : null }) };
  const mocks: Record<string, unknown> = {
    "@/lib/config/runtime-switches": { isFeatureDisabled: async () => false },
    "next/server": { NextResponse: { json: (value: unknown, init?: ResponseInit) => Response.json(value, init) }, after: () => {} },
    "@/lib/supabase/admin": { supabaseAdmin: { from: () => dbQuery, rpc: async (name: string, args: Record<string, unknown>) => {
      if (name.startsWith("save") && failure !== "save") cachedSummary = structuredClone(args.p_summary) as Record<string, unknown>;
      return { data: name.startsWith("claim") ? 1 : failure === "save" ? false : true };
    } } },
    "@/lib/constants/teams": { TEAMS: [{ id: 1, shortName: "LG" }, { id: 2, shortName: "두산" }], isAllStarGameId: () => false },
    "@/lib/crawler/kbo-api": {
      fetchGames: async () => [game], fetchBoxScore: async () => box, fetchGameLinescore: async () => lines,
      fetchStandings: async () => { calls.standings++; return st; }, buildRankMap: () => new Map([[1, 4], [2, 5]]),
    },
    "@/lib/crawler/kbo-live-text": { loadKboLiveText: async () => ({
      gameId: game.gameId, linescore: failure === "roster-score" ? { ...lines, away: { ...lines.away, R: 99 } } : lines, boxScore: {
        awayBatters: [{ name: "두산타자", atBats: 4, runs: game.awayScore, hits: 1 }],
        homeBatters: [{ name: "LG타자", atBats: 4, runs: game.homeScore, hits: 1 }],
        awayPitchers: [{ name: "두산투수", inningsPitched: "8", runs: game.homeScore, earnedRuns: game.homeScore, pitchCount: 80 }],
        homePitchers: [{ name: "LG투수", inningsPitched: "9", runs: game.awayScore, earnedRuns: 0, pitchCount: 90 }],
      },
    }) },
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
      if (failure === "model") throw new Error("model offline");
      prompts.push(JSON.parse(String(init.body)).contents[0].parts[0].text);
      const draw = game.awayScore === game.homeScore;
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ headline: draw ? "LG와 두산 무승부" : "LG, 두산에 승리", winner: draw ? "무승부" : "LG", insight: narrative ?? "안정적인 투구가 돋보였다.", standingsImpact: "stale", seriesContext: "stale", ...fields }) }] } }] });
    },
  });
  const response = await routeModule.exports.POST({ json: async () => ({ gameId: game.gameId }) });
  if (retryRecord) {
    const before = calls.generated;
    await routeModule.exports.POST({ json: async () => ({ gameId: game.gameId }) });
    assert.equal(calls.generated, before, 'record cooldown prevents model retry storms');
    assert.ok(cachedSummary);
    (cachedSummary as Record<string, unknown>)._recordRetryAfter = Date.now() - 1;
    await routeModule.exports.POST({ json: async () => ({ gameId: game.gameId }) });
    assert.ok(calls.generated > before, 'expired record cache permits a new generation');
  }
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

 test("POST false shutout falls back to canonical record summary after retries", async () => {
  const result = await callRoute(wc, [wc], false, "LG투수는 단 1점도 내주지 않았다.");
  assert.equal(result.status, 200);
  assert.equal(result.calls.generated, 2);
  assert.equal(result.body.source, "record-template");
  assert.equal(result.body.summary.summaryKind, "record");
  assert.doesNotMatch(JSON.stringify(result.body.summary), /단 1점도|무실점/);
  assert.match(result.body.summary.headline, /4:1/);
  assert.equal(result.body.summary._verifiedPitcherFacts, undefined);
});

test("POST model outage uses records, but wrong-game scores and failed save never claim success", async () => {
  const offline = await callRoute(wc, [wc], false, undefined, {}, "model");
  assert.equal(offline.status, 200);
  assert.equal(offline.body.source, "record-template");
  const mismatch = await callRoute(wc, [wc], false, undefined, {}, "roster-score");
  assert.equal(mismatch.status, 503);
  assert.equal(mismatch.calls.generated, 0);
  const notSaved = await callRoute(wc, [wc], false, "LG투수 무실점", {}, "save");
  assert.equal(notSaved.status, 409);
  assert.equal(notSaved.body.summary, undefined);
});


test('POST record fallback cache permits regeneration after durable cooldown',async()=>{
 const result=await callRoute(wc,[wc],false,undefined,{},'model',true);
 assert.equal(result.status,200);
});
