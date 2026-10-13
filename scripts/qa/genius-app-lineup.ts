import assert from "node:assert/strict";
import { loadAppLineups, renderAppLineup, type AppLineupSnapshot } from "../../src/lib/baseball-qa/app-lineup";
import { renderGameConversation, type GameConversationInput } from "../../src/lib/baseball-qa/game-conversation";
import { fetchNaverLineup } from "../../src/lib/crawler/naver-lineup";
import { answerQuestion, type QaDeps } from "../../src/lib/baseball-qa/pipeline";

export async function checkAppLineup() {
  const now = Date.parse("2026-10-05T08:00:00Z");
  const game = { gameId: "20261005HHSS0", awayName: "한화", homeName: "삼성", stadium: "대구", time: "18:30", status: "scheduled" };
  const side = (prefix: string) => ({ starter: `${prefix}선발`, batters: Array.from({ length: 9 }, (_, i) =>
    ({ order: i + 1, name: `${prefix}타자${i + 1}`, position: "DH", positionKr: "지명타자" })) });
  const snap: AppLineupSnapshot = { gameId: game.gameId, date: "2026-10-05", awayName: game.awayName, homeName: game.homeName,
    source: "naver-preview", fetchedAt: now, lineup: { confirmed: true, away: side("한화"), home: side("삼성") } };
  const q = "오늘 한화 타순 알려줘";
  const plan = { action: "app_facts", appRequest: { kind: "lineup", informationNeed: "batting_order", period: "today",
    quote: q, intentSource: "question", intentQuote: q },
    target: { source: "question", quote: "한화", teams: ["한화"], excludedTeams: [], backgroundTeams: [], stadium: "", excludedStadiums: [] } };
  const input: GameConversationInput = { question: q, date: snap.date, nowMs: now, games: [game], favoriteTeam: null,
    teamNames: { question: ["한화"], context_question: [], profile: [] }, lineups: { [game.gameId]: snap } };
  const rendered = renderGameConversation(JSON.stringify(plan), input)!;
  assert.equal(rendered.source, "kbo_structured");
  assert.match(rendered.answer, /한화 선발 타순: 1번 한화타자1.*9번 한화타자9/);
  assert.doesNotMatch(rendered.answer, /삼성타자/);
  assert.match(rendered.answer, /교체·현재 타석을 뜻하지 않습니다/);
  for (const bad of [
    { ...snap, gameId: "20261004HHSS0" }, { ...snap, date: "2026-10-04" },
    { ...snap, awayName: "두산" }, { ...snap, fetchedAt: now - 60_001 }, { ...snap, fetchedAt: now + 1 },
    { ...snap, lineup: { ...snap.lineup, away: { ...snap.lineup.away, batters: snap.lineup.away.batters.slice(1) } } },
    { ...snap, lineup: { ...snap.lineup, away: { ...snap.lineup.away, batters: snap.lineup.away.batters.map((b) => ({ ...b, order: 1 })) } } },
  ]) assert.equal(renderAppLineup(bad, game, snap.date, now, ["한화"]), null);
  assert.equal(renderAppLineup(snap, { ...game, status: "cancelled" }, snap.date, now, []), null);
  const missing = renderGameConversation(JSON.stringify(plan), { ...input, lineups: {} })!;
  assert.equal(missing.source, "history_hold"); assert.doesNotMatch(missing.answer, /한화타자1/);
  let calls = 0;
  const adapter = { now: () => now,
    fetchConfirmed: async () => true,
    fetchLineup: async (id: string, opts?: { requireGameIdentity?: boolean }) => {
      calls++; assert.equal(id, game.gameId); assert.equal(opts?.requireGameIdentity, true); return snap.lineup;
    } };
  const request = { game, date: snap.date };
  assert.deepEqual(await loadAppLineups([request, request], adapter), { [game.gameId]: snap });
  assert.equal(calls, 1, "deduplicate selected games");
  assert.deepEqual(await loadAppLineups([request], { ...adapter, fetchConfirmed: async () => false }), {}, "KBO explicit false must win");
  assert.deepEqual(await loadAppLineups([{ ...request, date: "2026-10-04" }, { ...request, game: { ...game, status: "cancelled" } },
    { ...request, game: { ...game, gameId: "20261005HHSS1" } }], adapter), {}, "wrong date/cancelled/DH must not load");

  // Exercise the real transport adapter: stale/mismatched response is rejected.
  const originalFetch = globalThis.fetch;
  try {
    const full = (prefix: string) => [{ positionName: "선발투수", playerName: `${prefix}선발` },
      ...side(prefix).batters.map((b) => ({ positionName: b.positionKr, playerName: b.name }))];
    const data = { code: 200, success: true, result: { previewData: { gameInfo: { gdate: "20261005", aCode: "HH", hCode: "SS" },
      awayTeamLineUp: { fullLineUp: full("한화") }, homeTeamLineUp: { fullLineUp: full("삼성") } } } };
    globalThis.fetch = async (url) => { assert.match(String(url), /20261005HHSS02026\/preview$/); return Response.json(data); };
    assert.ok(await fetchNaverLineup(game.gameId, { requireGameIdentity: true }));
    data.result.previewData.gameInfo.gdate = "20261004";
    assert.equal(await fetchNaverLineup(game.gameId, { requireGameIdentity: true }), null);
    data.result.previewData.gameInfo.gdate = "20261005"; data.result.previewData.gameInfo.hCode = "LG";
    assert.equal(await fetchNaverLineup(game.gameId, { requireGameIdentity: true }), null);
  } finally { globalThis.fetch = originalFetch; }

  // Production pipeline seam, including lazy loading and bounded fallback.
  for (const mode of ["ok", "error", "hang", "schedule", "foreign"] as const) {
    let loaded = 0, selectors = 0;
    const deps: QaDeps = {
      now: () => now, loadGlossary: async () => [], loadPlayers: async () => [],
      getCache: async () => null, setCache: async () => undefined,
      reserveDaily: async () => ({ allowed: true, remaining: 9 }), log: async () => undefined,
      loadGameConversation: async () => ({ games: [game], favoriteTeam: null }),
      callGameConversation: async () => {
        selectors++;
        const selected = mode === "schedule" ? { ...plan, appRequest: { ...plan.appRequest, kind: "schedule", informationNeed: "game_schedule" } }
          : mode === "foreign" ? { ...plan, target: { ...plan.target, teams: ["두산"] } } : plan;
        return { text: JSON.stringify(selected), inputTokens: 1, outputTokens: 1 };
      },
      loadGameLineups: async (requests) => {
        loaded++; assert.deepEqual(requests, [request]);
        if (mode === "error") throw new Error("upstream down");
        if (mode === "hang") return new Promise(() => undefined);
        return { [game.gameId]: snap };
      },
      callLlm: async () => { throw new Error("generated answer must not replace facts"); },
    };
    const result = await answerQuestion("qa-app-lineup", q, deps);
    assert.equal(selectors, 1, mode);
    assert.equal(loaded, mode === "schedule" || mode === "foreign" ? 0 : 1, mode);
    if (mode === "ok") { assert.equal(result.source, "kbo_structured"); assert.match(result.answer!, /한화타자1/); }
    if (mode === "error" || mode === "hang") { assert.equal(result.source, "history_hold"); assert.doesNotMatch(result.answer!, /한화타자1/); }
  }
}
