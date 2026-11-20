/** Reviewer-run: #1646 operating question plus synthetic boundary fixtures. */
import assert from "node:assert/strict";
import { answerQuestion, teamIdOfCanonical, type QaDeps } from "../../src/lib/baseball-qa/pipeline";
import { composeTeamRecordProvenance, resolveTeamRecordIntent, type StandingsRow } from "../../src/lib/baseball-qa/stats/team-record";
const now = Date.parse("2026-11-18T02:30:00Z");
const teamId = teamIdOfCanonical("LG")!;
const row: StandingsRow = { teamId, teamName: "LG", wins: 78, losses: 61, draws: 5, games: 144, winRate: .561, gamesBehind: 0, ranking: 1 };
async function ask(question: string, rows = [row], metadata: { season?: number; fetchedAt?: string } = { season: 2026, fetchedAt: "2026-11-18T02:25:00Z" }) {
  let calls = 0; const logs: string[] = []; const loggedAnswers: string[] = [];
  const deps = {
    loadGlossary: async () => [], loadPlayers: async () => [],
    getCache: async () => null, setCache: async () => {},
    reserveDaily: async () => ({ allowed: true, remaining: 9 }),
    log: async (r: { matchPath: string; answer: string }) => { logs.push(r.matchPath); loggedAnswers.push(r.answer); },
    now: () => now,
    callLlm: async () => { throw new Error("unexpected LLM"); },
    searchRag: async () => [],
    fetchTeamRecord: {
      fetchStandings: async () => { calls++; return { rows, ...metadata }; },
      fetchTeamRecords: async () => ({ season: 2026, batting: [], pitching: [] }),
    },
  } as unknown as QaDeps;
  const result = await answerQuestion("qa-team-metrics", question, deps);
  assert.equal(loggedAnswers.at(-1), result.answer, "stored answer must include the same provenance");
  return { result, calls, logs };
}
async function main() {
  for (const q of ["LG 올해 몇 승 몇 패야?", "LG 몇 패 몇 승이야?", "LG 승리 수와 패배 수 알려줘"]) {
    const { result, calls, logs } = await ask(q);
    console.log(JSON.stringify({ question: q, answer: result.answer, source: result.source }));
    assert.equal(result.source, "kbo_structured", q);
    assert.ok(result.answer.includes("승은 78"), q);
    assert.ok(result.answer.includes("패는 61"), q);
    assert.ok(result.answer.includes("앱 순위표 · 2026 시즌 · 응답 시각 2026-11-18 11:25 KST"), q);
    assert.ok(result.answer.includes("실제 수집·경기 반영 완료 시각은 아님"), q);
    assert.ok(!result.answer.includes("11:30"), "must not replace response timestamp with the injected clock");
    assert.equal(result.answer.match(/📊/g)?.length, 1);
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
  assert.equal((await ask("LG 2026년 몇 승 몇 패")).result.source, "kbo_structured");
  assert.equal((await ask("LG 몇 승")).result.answer.split("\n\n")[0], "LG 승은 78입니다.");
  assert.equal((await ask("LG 몇 패")).result.answer.split("\n\n")[0], "LG 패는 61입니다.");
  const missing = await ask("LG 몇 승 몇 패", [{ ...row, losses: undefined } as unknown as StandingsRow]);
  assert.ok(missing.result.answer.includes("승은 78"));
  assert.ok(missing.result.answer.includes("패 자료는 확인하지 못했습니다"));
  assert.ok(!missing.result.answer.includes("undefined"));
  const nullValue = await ask("LG 몇 승 몇 패", [{ ...row, losses: null } as unknown as StandingsRow]);
  assert.ok(nullValue.result.answer.includes("패 자료는 확인하지 못했습니다"));
  assert.equal((await ask("LG 몇 승 몇 패", [])).result.source, "history_hold");
  assert.equal((await ask("삼성 몇 승 몇 패", [{ ...row, teamId: teamIdOfCanonical("삼성")! }])).result.answer.split("\n\n")[0], "삼성 승은 78입니다.\n삼성 패는 61입니다.");
  for (const q of ["LG 2025년 몇 승 몇 패", "LG 2025년 몇 승", "LG 작년 몇 승 몇 패", "LG 2025년과 2026년 몇 승 몇 패", "LG와 두산 몇 승 몇 패", "LG와 두산 상대전적 알려줘"]) {
    const { result } = await ask(q);
    assert.notEqual(result.source, "kbo_structured", q);
    assert.ok(!result.answer.includes("78"), q);
  }
  const absent = (await ask("LG 몇 승 몇 패", [row], {})).result.answer;
  assert.ok(absent.includes("시즌 미확인 · 응답 시각 미확인"));
  assert.ok(!absent.includes("11:30"));
  const badDate = (await ask("LG 몇 승", [row], { season: 2026, fetchedAt: "not-a-date" })).result.answer;
  assert.ok(badDate.includes("응답 시각 미확인"));
  assert.ok(!badDate.includes("Invalid Date"));
  const pair = await ask("LG와 두산 순위", [row, { ...row, teamId: teamIdOfCanonical("두산")!, teamName: "두산", ranking: 2 }]);
  assert.equal(pair.result.source, "kbo_structured");
  assert.ok(pair.result.answer.includes("앱 순위표 · 2026 시즌 · 응답 시각 2026-11-18 11:25 KST"));
  const standings = { rows: [row], season: 2026, fetchedAt: "2026-11-18T02:25:00Z" };
  const records = { season: 2025, fetchedAt: "2026-11-17T23:59:00Z" };
  const mixed = composeTeamRecordProvenance(["wins", "hr", "era"], standings, records);
  assert.equal(mixed.match(/📊/g)?.length, 2, "one line per actual endpoint, not metric");
  assert.ok(mixed.includes("앱 팀기록 · 2025 시즌 · 응답 시각 2026-11-18 08:59 KST"));
  assert.ok(mixed.includes("앱 순위표 · 2026 시즌 · 응답 시각 2026-11-18 11:25 KST"));
  assert.ok(!composeTeamRecordProvenance(["wins"], standings, records).includes("앱 팀기록"));
  assert.ok(!composeTeamRecordProvenance(["hr"], standings, records).includes("앱 순위표"));
  assert.equal(composeTeamRecordProvenance([], standings, records), "");
  assert.ok(!missing.result.answer.includes("앱 팀기록"));
  assert.ok(!(await ask("LG 몇 승", [])).result.answer.includes("📊"));
  console.log("PASS team multi-metric pipeline, response provenance and boundaries");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
