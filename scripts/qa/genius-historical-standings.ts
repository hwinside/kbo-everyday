import assert from "node:assert/strict";
import naverObserved from "./fixtures/genius-historical-standings-naver-20261117.json";
import { answerQuestion, type QaDeps, type LlmResult } from "../../src/lib/baseball-qa/pipeline";
import { renderGameConversation, type GameConversationInput } from "../../src/lib/baseball-qa/game-conversation";
import { parseHistoricalStandings, requestedHistoricalSeason, loadHistoricalStandings } from "../../src/lib/baseball-qa/historical-standings";

// Synthetic contract fixture, NOT a claim about actual 2025 standings.
const now = Date.parse("2026-11-17T04:00:00Z");
const payload = { success: true, result: { seasonTeamStats: ["LG", "HH", "SK", "SS", "NC", "KT", "LT", "HT", "OB", "WO"].map((teamId, i) => ({
  teamId, teamName: ["LG", "한화", "SSG", "삼성", "NC", "KT", "롯데", "KIA", "두산", "키움"][i], ranking: i + 1, gameCount: 144, winGameCount: 81 - i * 2, loseGameCount: 63 + i * 2, drawnGameCount: 0,
})) } };
const question = "2025 KBO 정규시즌 최종 순위 알려줘";
const proposal = { action: "app_facts", evidenceSource: "none", attendanceEvidence: "",
  appRequest: { informationNeed: "team_standing", kind: "standings", period: "season", quote: question,
    intentSource: "question", intentQuote: question, seasonCompetition: "regular", competitionQuote: "정규시즌", seasonExtent: "season_total",
    seasonRequest: { basis: "year", year: 2025, offset: 0, source: "question", quote: "2025" } },
  target: { source: "none", quote: "", teams: [], excludedTeams: [], backgroundTeams: [], excludedStadiums: [], stadium: "" } };
const archived = parseHistoricalStandings(payload, 2025, now)!;
const input: GameConversationInput = { question, date: "2026-11-17", nowMs: now, favoriteTeam: null, games: [],
  teamNames: { question: [], context_question: [], profile: [] },
  appFacts: { tomorrow: { date: "2026-11-18", games: [] }, standings: null, historicalStandings: archived } };

export async function checkHistoricalStandings() {
  assert.ok(archived);
  // Raw browser responses captured 2026-11-17, not repaired/reordered fixtures.
  // On R1 these return non-null and falsely label postseason ranks as regular.
  for (const season of [2015, 2019, 2021, 2022] as const) {
    assert.equal(parseHistoricalStandings(naverObserved[season], season, now), null,
      `${season}: unverified regular-season order must HOLD`);
  }
  const real2025 = parseHistoricalStandings(naverObserved[2025], 2025, now);
  assert.ok(real2025, "do not blanket-block historical seasons");
  assert.equal(real2025.rows[0].displayName, "LG");
  assert.equal(real2025.rows[0].ranking, 1);
  // Corrected rank order still cannot resolve tied records without tie-break evidence.
  for (const season of [2019, 2021] as const) {
    const tied = structuredClone(naverObserved[season]);
    tied.result.seasonTeamStats.sort((a, b) =>
      b.winGameCount * (a.winGameCount + a.loseGameCount) - a.winGameCount * (b.winGameCount + b.loseGameCount));
    tied.result.seasonTeamStats.forEach((row, index) => { row.ranking = index + 1; });
    assert.equal(parseHistoricalStandings(tied, season, now), null, `${season}: tie cannot be resolved by array order`);
  }
  const renamed = structuredClone(payload);
  renamed.result.seasonTeamStats[2].teamName = "SK";
  assert.equal(parseHistoricalStandings(renamed, 2019, now)?.rows[2].displayName, "SK");
  const render = (p = proposal, i = input) => renderGameConversation(JSON.stringify(p), i);
  assert.equal(render()?.source, "kbo_structured");
  assert.match(render()!.answer, /2025년 KBO 정규시즌 최종 순위/);
  assert.match(render()!.answer, /LG: 1위, 81승 63패 0무/);
  assert.match(render()!.answer, /출처: 네이버 스포츠/);
  assert.doesNotMatch(render()!.answer, /KBO 공식 자료/);
  const realRendered = render(proposal, { ...input, appFacts: { ...input.appFacts!, historicalStandings: real2025 } });
  assert.equal(realRendered?.source, "kbo_structured");
  assert.match(realRendered!.answer, /LG: 1위/);
  // Bare KBO season standings may use regular-season scope, disclosed in answer.
  for (const question of ["2025 KBO 순위", "2025 KBO 최종 순위"]) {
    const scoped = render({ ...proposal, appRequest: { ...proposal.appRequest,
      quote: question, intentQuote: question, competitionQuote: "KBO" } }, { ...input, question });
    assert.equal(scoped?.source, "kbo_structured");
    assert.match(scoped!.answer, /정규시즌 최종 순위/);
    assert.match(scoped!.answer, /포스트시즌 결과를 포함한 순위가 아닙니다/);
  }
  const unspecified = { ...proposal, appRequest: { ...proposal.appRequest, seasonCompetition: "unspecified", competitionQuote: "" } };
  assert.equal(render(unspecified)?.source, "context_missing");
  for (const seasonCompetition of ["preseason", "postseason"]) {
    assert.equal(render({ ...proposal, appRequest: { ...proposal.appRequest, seasonCompetition } })?.source, "history_hold");
  }
  assert.equal(render({ ...proposal, appRequest: { ...proposal.appRequest, seasonExtent: "as_of" } })?.source, "history_hold");
  assert.equal(render({ ...proposal, appRequest: { ...proposal.appRequest, competitionQuote: "invented" } })?.source, "history_hold");
  for (const changed of [null, { ...archived, season: 2024 }, { ...archived, sourceUrl: "https://wrong.example" },
    { ...archived, fetchedAt: now + 1 }, { ...archived, fetchedAt: now - 300001 }]) {
    assert.equal(render(proposal, { ...input, appFacts: { ...input.appFacts!, historicalStandings: changed } })?.source, "history_hold");
  }
  assert.equal(requestedHistoricalSeason({ seasonRequest: { basis: "relative", offset: -1, source: "question", quote: "지난 시즌" } },
    { ...input, question: "지난 시즌 정규시즌 순위" }), null);
  assert.equal(render({ ...proposal, appRequest: { ...proposal.appRequest,
    seasonRequest: { basis: "relative", year: 0, offset: -1, source: "question", quote: question } } })?.source, "context_missing");
  assert.doesNotMatch(render()!.answer, /api-gw|REGULAR_SEASON/);
  assert.equal(requestedHistoricalSeason({ seasonRequest: { basis: "year", year: 2024, source: "question", quote: "2025" } }, input), null);
  assert.equal(requestedHistoricalSeason({ seasonRequest: { basis: "year", year: 2027, source: "question", quote: "2027" } },
    { ...input, question: "2027 정규시즌 순위" }), null);
  // Provider corruption must not become a current-year or exhibition fallback.
  for (const mutation of [
    (p: typeof payload) => { p.result.seasonTeamStats.pop(); },
    (p: typeof payload) => { p.result.seasonTeamStats[0].gameCount = 7; },
    (p: typeof payload) => { p.result.seasonTeamStats[0].ranking = 0; },
    (p: typeof payload) => { p.result.seasonTeamStats[0].teamId = "HH"; },
    (p: typeof payload) => { p.result.seasonTeamStats[0].winGameCount = 82; },
    // Complete, balanced totals and unique ranks still allow postseason order.
    (p: typeof payload) => { p.result.seasonTeamStats[0].ranking = 2; p.result.seasonTeamStats[1].ranking = 1; },
    (p: typeof payload) => {
      for (const row of p.result.seasonTeamStats.slice(0, 2)) { row.winGameCount = 80; row.loseGameCount = 64; }
    },
    (p: typeof payload) => { Object.assign(p.result.seasonTeamStats[0], { seasonId: "2024" }); },
    (p: typeof payload) => { Object.assign(p.result.seasonTeamStats[0], { gameType: "PRESEASON" }); },
  ]) { const p = structuredClone(payload); mutation(p); assert.equal(parseHistoricalStandings(p, 2025, now), null); }

  // Real loader contract: request year+competition, no redirects/current fallback.
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  const originalWarn = console.warn, originalInfo = console.info;
  const events: { season: number; outcome: string; status?: number; elapsedMs: number }[] = [];
  console.warn = console.info = (_tag, event) => { events.push(event); };
  try {
    globalThis.fetch = async (url, options) => {
      fetches++; assert.match(String(url), /\/2025\/teams\?gameType=REGULAR_SEASON$/);
      assert.equal(options?.redirect, "manual");
      assert.equal(new Headers(options?.headers).get("User-Agent"), "Mozilla/5.0 (compatible; KboEveryday/1.0)");
      return new Response(JSON.stringify(payload), { status: 200 });
    };
    assert.equal((await loadHistoricalStandings(2025))?.rows.length, 10);
    globalThis.fetch = async () => { fetches++; return new Response("unavailable", { status: 502 }); };
    assert.equal(await loadHistoricalStandings(2025), null);
    assert.equal(fetches, 2, "no current-year fallback request");
    assert.equal(events[0].outcome, "success");
    assert.equal(events[1].outcome, "http_error");
    assert.equal(events[1].status, 502);
    const failures = [
      { outcome: "redirect", response: () => new Response(null, { status: 302, headers: { Location: "https://example.com/private" } }) },
      { outcome: "invalid_json", response: () => new Response("private upstream body", { status: 200 }) },
      { outcome: "parse_rejected", response: () => new Response(JSON.stringify(naverObserved[2019]), { status: 200 }) },
      { outcome: "network_error", response: () => { throw new TypeError("private network details"); } },
      { outcome: "timeout", response: () => { throw new DOMException("private timeout details", "TimeoutError"); } },
    ];
    for (const failure of failures) {
      const before = fetches;
      globalThis.fetch = async () => { fetches++; return failure.response(); };
      assert.equal(await loadHistoricalStandings(2025), null);
      assert.equal(fetches, before + 1, "no redirect follow, retry or current-season fallback");
      assert.equal(events.at(-1)?.outcome, failure.outcome);
      assert.equal(events.at(-1)?.season, 2025);
      assert.ok(events.at(-1)!.elapsedMs >= 0);
    }
    assert.equal(events.length, 7, "one terminal event per request");
    assert.doesNotMatch(JSON.stringify(events), /private|example.com/);
  } finally { globalThis.fetch = originalFetch; console.warn = originalWarn; console.info = originalInfo; }

  for (const unavailable of [false, true]) {
    let stored: LlmResult | null = null, started = false, loads = 0, calls = 0;
    const deps: QaDeps = {
      loadGlossary: async () => [], loadPlayers: async () => [], getCache: async () => null,
      setCache: async () => { throw new Error("historical standings must not enter shared cache"); },
      reserveDaily: async () => ({ allowed: true, remaining: 9 }), now: () => now, log: async () => {},
      getLlmState: async () => ({ started, result: stored }),
      acquireLlmStart: async () => { if (started) return false; started = true; return true; },
      storeLlm: async result => { stored = result; },
      loadGameConversation: async () => ({ ...input, appFacts: { ...input.appFacts!, historicalStandings: null } }),
      callGameConversation: async () => { calls++; return { text: JSON.stringify(proposal), inputTokens: 1, outputTokens: 1 }; },
      loadHistoricalStandings: async season => { loads++; assert.equal(season, 2025); return unavailable ? null : archived; },
      callLlm: async () => { throw new Error("must not generate historical standings"); },
      enableTeamRag: true, searchRag: async () => { throw new Error("must not retrieve ambiguous old prose"); },
    };
    const first = await answerQuestion("qa-history-1641", question, deps);
    assert.equal(first.source, unavailable ? "history_hold" : "kbo_structured");
    assert.ok(stored); assert.equal(loads, 1); assert.equal(calls, 1);
    const replay = await answerQuestion("qa-history-1641", question, deps);
    assert.equal(replay.answer, first.answer); assert.equal(replay.source, first.source);
    assert.equal(loads, 1); assert.equal(calls, 1);
  }
}
