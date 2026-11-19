/** Reviewer-run: real #1650 UI/DM question and previous-turn regression. */
import assert from "node:assert/strict";
import { answerQuestion, teamIdOfCanonical, type QaDeps, type PlayerRef } from "../../src/lib/baseball-qa/pipeline";
const now = Date.parse("2026-11-19T02:30:00Z");
const player = { kboId: "52402", name: "김영웅", team: "삼성", position: "내야수" };
async function ask(question: string, previous = false) {
  const logs: string[] = []; let fetches = 0;
  const deps = {
    loadPreviousTurn: previous ? async () => ({ question: "LG 승리 수와 패배 수 알려줘", answer: "LG 승은 78입니다.\nLG 패는 65입니다.", jobSource: "kbo_structured", answeredAt: "2026-11-19T02:29:40Z", currentCreatedAt: "2026-11-19T02:30:00Z" }) : undefined,
    loadGlossary: async () => [], loadPlayers: async () => [player] as PlayerRef[],
    getCache: async () => null, setCache: async () => {},
    reserveDaily: async () => ({ allowed: true, remaining: 9 }),
    log: async (r: { answer: string }) => { logs.push(r.answer); }, now: () => now,
    callLlm: async () => { throw new Error("unexpected LLM"); }, searchRag: async () => [],
    fetchSeasonRecord: async () => { fetches++; return []; },
    fetchTeamRecord: {
      fetchStandings: async () => { fetches++; return { season: 2026, fetchedAt: new Date(now).toISOString(), rows: [{ teamId: teamIdOfCanonical("LG"), teamName: "LG", wins: 78, losses: 61, draws: 5, games: 144, winRate: .561, gamesBehind: 0, ranking: 1 }] }; },
      fetchTeamRecords: async () => ({ season: 2026, batting: [], pitching: [] }),
    },
  } as unknown as QaDeps;
  const result = await answerQuestion("qa-period-guidance", question, deps);
  console.log(JSON.stringify({ question, answer: result.answer, source: result.source, fetches }));
  assert.deepEqual(logs, [result.answer], "persist exactly the delivered answer");
  return { result, fetches };
}
async function main() {
  // First assert reproduces production T4 on base, without importing new helpers.
  for (const q of ["LG 2025년 몇 승 몇 패", "LG 작년 몇 승 몇 패", "두산 작년 몇 승 몇 패"]) {
    const { result, fetches } = await ask(q);
    assert.equal(result.source, "blocked", q);
    assert.ok(result.answer.includes("팀 기록"), q);
    assert.ok(!/2019|통산 기록|연도별 기록/.test(result.answer), q);
    assert.ok(!result.answer.includes("78"), q); assert.equal(fetches, 0, q);
  }
  const contextual = await ask("LG 2025년 몇 승 몇 패", true);
  assert.ok(contextual.result.answer.includes("팀 기록")); assert.equal(contextual.fetches, 0);
  const current = await ask("LG 올해 몇 승 몇 패야?");
  assert.equal(current.result.source, "kbo_structured");
  assert.ok(current.result.answer.includes("승은 78")); assert.ok(current.result.answer.includes("패는 61"));
  for (const q of ["김영웅 최근 5경기 타율", "삼성 김영웅 최근 5경기 타율"]) {
    const { result, fetches } = await ask(q);
    assert.equal(result.source, "blocked", q);
    assert.ok(result.answer.includes("2019년 타율"), q);
    assert.ok(!result.answer.includes("팀 기록"), q); assert.equal(fetches, 0, q);
  }
  // No rank operation and no bound entity: reach the generic period guard
  // instead of the earlier rank/history or mixed-entity clarification gates.
  // Assert through answerQuestion, not by calling the copy helper directly.
  for (const q of ["최근 5경기 타율", "월별 타율"]) {
    const { result, fetches } = await ask(q);
    assert.equal(result.source, "blocked", q);
    assert.equal(result.answer, "요청하신 대상·기록·기간 조합은 현재 확인할 수 없습니다. 선수 기록과 팀 기록의 지원 범위는 서로 다릅니다.", q);
    assert.doesNotMatch(result.answer, /2019|통산|연도별|요청하신 팀 기록|78/, q);
    assert.equal(fetches, 0, q);
  }
  const split = await ask("김영웅 후반기 타율");
  assert.ok(split.result.answer.includes("상황·대회·기간"));
  console.log("PASS entity-bound unsupported-period guidance");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
