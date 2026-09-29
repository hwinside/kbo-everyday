/** Reviewer-run pipeline contract; synthetic cases are not accuracy scores. */
import assert from "node:assert/strict";
import { answerQuestion, type QaDeps } from "../../src/lib/baseball-qa/pipeline";
import { liveScoreGuide } from "../../src/lib/baseball-qa/stats/live-score-guide";
import { mentionsTeamForGate } from "../../src/lib/baseball-qa/pipeline";
async function main() {
  for (const question of ["지금 키움vs롯데 몇대몇", "현재 LG 경기 점수 알려줘", "오늘 삼성 스코어", "지금 KBO 몇 대 몇이야", "롯데 실시간 경기 결과", "오늘 키움 VS 롯데 스코어 알려줘"]) {
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
      fetchTeamStandings: forbidden, fetchTeamRecords: forbidden, fetchCurrentSeasonRecord: forbidden,
      getLlmState: async () => ({ started: owns, result: stored, ownerActive: false }),
      acquireLlmStart: async () => { owns = true; return true; },
      storeLlm: async (result: unknown) => { stored = result; },
    } as unknown as QaDeps;
    const result = await answerQuestion("qa-only", question, deps);
    assert.equal(result.source, "scope_guide", question);
    assert.match(result.answer, /실시간으로 확인하지 못했습니다/);
    assert.deepEqual(logs, ["scope_guide"]);
    assert.ok(stored, "navigation must survive durable storage");
    assert.equal(result.sourceUrl, "https://keubo.fan/games");
    assert.match(result.answer, /https:\/\/keubo\.fan\/games/);
    assert.doesNotMatch(result.answer, /팀 기록.*없|\d+\s*대\s*\d+|\d+회/);
    const replay = await answerQuestion("qa-only", question, deps);
    assert.equal(replay.answer, result.answer);
    assert.equal(replay.sourceUrl, result.sourceUrl);
  }
  for (const question of ["어제 LG 스코어", "지금 어제 LG 점수 알려줘", "오늘 삼성 타율", "LG 현재 순위", "현재 키움 상대전적", "오늘 LG 점수를 못 낸 이유", "현재 LG 점수 규칙", "지금 LG 몇대몇이면 콜드야 규정 알려줘", "오늘 MLB 스코어", "지금 축구 몇대몇", "오늘 삼성 경기 예상 점수", "오늘 3회 LG 점수", "2025년 오늘 LG 점수", "9/29 LG 현재 스코어", "내일 LG 스코어", "오늘 삼성 점수 계산 방법", "오늘 LG 점수와 타율", "현재 삼성 평균 점수"]) {
    assert.equal(liveScoreGuide(question, mentionsTeamForGate(question.replace(/vs\.?/gi, " "))), null, question);
  }
  console.log("PASS live score navigation / provenance / durable replay / negative scopes");
}
main().catch((error) => { console.error(error); process.exit(1); });
