/** Reviewer-run: #1646 operating question plus synthetic boundary fixtures. */
import assert from "node:assert/strict";
import { answerQuestion, teamIdOfCanonical, type QaDeps } from "../../src/lib/baseball-qa/pipeline";
import { resolveTeamRecordIntent, type StandingsRow } from "../../src/lib/baseball-qa/stats/team-record";
const now = Date.parse("2026-11-18T02:30:00Z");
const teamId = teamIdOfCanonical("LG")!;
const row: StandingsRow = { teamId, teamName: "LG", wins: 78, losses: 61, draws: 5, games: 144, winRate: .561, gamesBehind: 0, ranking: 1 };
async function ask(question: string, rows = [row]) {
  let calls = 0; const logs: string[] = [];
  const deps = {
    loadGlossary: async () => [], loadPlayers: async () => [],
    getCache: async () => null, setCache: async () => {},
    reserveDaily: async () => ({ allowed: true, remaining: 9 }),
    log: async (r: { matchPath: string }) => { logs.push(r.matchPath); },
    now: () => now,
    callLlm: async () => { throw new Error("unexpected LLM"); },
    searchRag: async () => [],
    fetchTeamRecord: {
      fetchStandings: async () => { calls++; return { rows, season: 2026, fetchedAt: new Date(now).toISOString() }; },
      fetchTeamRecords: async () => ({ season: 2026, batting: [], pitching: [] }),
    },
  } as unknown as QaDeps;
  const result = await answerQuestion("qa-team-metrics", question, deps);
  return { result, calls, logs };
}
async function main() {
  for (const q of ["LG 올해 몇 승 몇 패야?", "LG 몇 패 몇 승이야?", "LG 승리 수와 패배 수 알려줘"]) {
    const { result, calls, logs } = await ask(q);
    console.log(JSON.stringify({ question: q, answer: result.answer, source: result.source }));
    assert.equal(result.source, "kbo_structured", q);
    assert.ok(result.answer.includes("승은 78"), q);
    assert.ok(result.answer.includes("패는 61"), q);
    assert.equal(calls, 1); assert.deepEqual(logs, ["kbo_structured"]);
  }
  for (const [q, metrics] of [
    ["LG 몇 승", ["wins"]], ["LG 몇 패", ["losses"]],
    ["LG 승률", ["winRate"]], ["LG 무승부", ["draws"]],
    ["LG 승패", ["record"]], ["LG 탈삼진", ["so"]],
    ["LG 타율과 OPS", ["avg", "ops"]],
    ["LG 몇 승 몇 승 몇 패", ["wins", "losses"]],
  ] as const) {
    const intent = resolveTeamRecordIntent(q); assert.equal(intent.kind, "query", q);
    if (intent.kind === "query") assert.deepEqual(intent.metrics, metrics, q);
  }
  assert.equal((await ask("LG 몇 승")).result.answer, "LG 승은 78입니다.");
  assert.equal((await ask("LG 몇 패")).result.answer, "LG 패는 61입니다.");
  const missing = await ask("LG 몇 승 몇 패", [{ ...row, losses: undefined } as unknown as StandingsRow]);
  assert.ok(missing.result.answer.includes("승은 78"));
  assert.ok(missing.result.answer.includes("패 자료는 확인하지 못했습니다"));
  assert.ok(!missing.result.answer.includes("undefined"));
  const nullValue = await ask("LG 몇 승 몇 패", [{ ...row, losses: null } as unknown as StandingsRow]);
  assert.ok(nullValue.result.answer.includes("패 자료는 확인하지 못했습니다"));
  assert.equal((await ask("LG 몇 승 몇 패", [])).result.source, "history_hold");
  assert.equal((await ask("삼성 몇 승 몇 패", [{ ...row, teamId: teamIdOfCanonical("삼성")! }])).result.answer, "삼성 승은 78입니다.\n삼성 패는 61입니다.");
  for (const q of ["LG 2025년 몇 승 몇 패", "LG와 두산 몇 승 몇 패", "LG와 두산 상대전적 알려줘"]) {
    const { result } = await ask(q);
    assert.notEqual(result.source, "kbo_structured", q);
    assert.ok(!result.answer.includes("78"), q);
  }
  console.log("PASS team multi-metric pipeline and boundaries");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
