/** Reviewer-run pipeline contract; synthetic cases are not accuracy scores. */
import assert from "node:assert/strict";
import { answerQuestion, type QaDeps } from "../../src/lib/baseball-qa/pipeline";
import { leaderboardGuide } from "../../src/lib/baseball-qa/stats/leaderboard-guide";
async function main() {
  for (const question of ["가장 안타가 많은 선수", "WAR 제일 높은 투수", "2026 시즌 홈런 상위 5명", "안타 순위 알려줘"]) {
    let stored: unknown = null;
    const logs: string[] = [];
    let owns = false;
    const forbidden = async () => { throw new Error("navigation must not fetch/generate numeric facts"); };
    const deps = {
      loadGlossary: async () => [], loadPlayers: async () => [],
      getCache: async () => null, setCache: async () => {},
      reserveDaily: async () => ({ allowed: true, remaining: 9 }),
      log: async (entry: { matchPath: string }) => { logs.push(entry.matchPath); },
      now: () => Date.parse("2026-09-29T12:00:00Z"),
      callLlm: forbidden, searchRag: forbidden, fetchSeasonRecord: forbidden,
      fetchBatterRanking: forbidden, agentFallback: forbidden,
      getLlmState: async () => ({ started: owns, result: stored, ownerActive: false }),
      acquireLlmStart: async () => { owns = true; return true; },
      storeLlm: async (result: unknown) => { stored = result; },
    } as unknown as QaDeps;
    const result = await answerQuestion("qa-only", question, deps);
    assert.equal(result.source, "scope_guide", question);
    assert.match(result.answer, /직접 확인하지 못했습니다/);
    assert.deepEqual(logs, ["scope_guide"]);
    assert.ok(stored, "navigation must survive durable storage");
    if (question.includes("안타")) {
      assert.match(result.answer, /안타 정렬 항목이 없습니다/);
      assert.equal(result.sourceUrl, "https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx");
    } else {
      assert.equal(result.sourceUrl, "https://keubo.fan/players/records");
    }
    if (question.includes("WAR")) assert.match(result.answer, /추정치이며 공식 WAR 순위가 아닙니다/);
    const replay = await answerQuestion("qa-only", question, deps);
    assert.equal(replay.answer, result.answer);
    assert.equal(replay.sourceUrl, result.sourceUrl);
  }
  for (const question of ["통산 안타 1위 누구야", "2024 홈런 순위", "WAR 뜻", "타율 순위 규정은?", "LG전 안타 순위", "포스트시즌 홈런 상위 5명", "안타 많이 쳤던 선수", "홈런이 높은 이유", "오늘 홈런 순위", "메이저리그 홈런 순위"]) {
    assert.equal(leaderboardGuide(question), null, question);
  }
  console.log("PASS leaderboard navigation / provenance / durable replay / negative scopes");
}
main().catch((error) => { console.error(error); process.exit(1); });
