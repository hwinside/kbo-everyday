/** Reviewer-owned execution. No DB, login, DM, quota or cache writes.
 * tsx scripts/qa/genius-scenario-outcome.ts [--live --base-root=... --out=...]
 * Live mode uses each ref's own production selector, then its own renderer.
 * Fixture standings are synthetic; this is NOT production/UI QA.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderGameConversation, type GameConversationInput } from "../../src/lib/baseball-qa/game-conversation";
import { conversationTeamCandidates, mentionedTeamCanonicals, isBareTeamName, answerQuestion, type QaDeps, type LlmResult } from "../../src/lib/baseball-qa/pipeline";

const cases = [
  { id: "observed-3433658", q: "엘지가 구자욱 영입할 확률", need: "not_app" },
  { id: "move-occurrence", q: "키움이 해외파 선수를 데려올 가능성이 얼마나 돼?", need: "not_app" },
  { id: "return-occurrence", q: "류현진이 복귀할 가능성은 얼마나 돼?", need: "not_app" },
  { id: "trade-occurrence", q: "삼성과 LG의 트레이드가 성사될까?", need: "not_app" },
  { id: "conditional-championship", q: "키움이 해외파 선수를 모두 데려오면 우승할 가능성이 높아져?", need: "scenario_outcome" },
  { id: "observed-3242076", q: "키움 메이저리거 선수들이 돌아오면 몇등임", need: "scenario_outcome" },
  { id: "paraphrase", q: "해외에 있는 키움 선수들을 전부 데려온다고 치면 순위가 어떻게 돼?", need: "scenario_outcome" },
  { id: "result-change", q: "키움이 남은 경기를 모두 이기면 몇 위가 돼?", need: "qualification_or_standing" },
  { id: "followup", q: "그러면 몇 등일까?", previous: "키움 메이저리거 선수들이 돌아온다고 가정해봐", need: "scenario_outcome" },
  { id: "current-rank", q: "키움 지금 몇 위야?", need: "team_standing" },
  { id: "already-returned", q: "키움 선수들이 이미 복귀했어. 현재 순위는 몇 위야?", need: "team_standing" },
  { id: "explicit-reset", q: "가정 말고 실제 키움 현재 순위는?", previous: "키움 메이저리거 선수들이 돌아오면 몇등임", need: "team_standing" },
  { id: "conditional-lookup", q: "오늘 키움 경기가 있으면 시간 알려줘", need: "game_schedule" },
  { id: "scheduled-prediction", q: "내일 삼성이 이겨 기아가 이겨?", need: "match_prediction" },
  { id: "game-gap-principle", q: "1.5게임차에서 높은팀이 지고 낮은팀이 이기면 순위바뀌어?", need: "not_app" },
  { id: "wildcard-rule", q: "한화가 와일드카드에서 지면 어떻게 돼?", need: "not_app" },
  { id: "rank-confirmation", q: "기아 롯데만 이기면 3위 확정?", need: "qualification_or_standing" },
  { id: "remaining-wins", q: "남은 경기 다 이기면 두산 4등 가능?", need: "qualification_or_standing" },
  { id: "today-win", q: "오늘 이기면 3위로 올라가?", need: "qualification_or_standing" },
  { id: "two-results", q: "삼성 지고 우리가 한화 이기면 1등?", need: "qualification_or_standing" },
  { id: "player-absence", q: "류현진이 없으면 한화 몇 위야?", need: "scenario_outcome" },
  { id: "definition", q: "평균자책점이 뭐야?", need: "not_app" },
] as const;
type Case = { id: string; q: string; previous?: string; need: string };
const now = Date.parse("2026-11-01T01:00:00Z");
function input(c: Case): GameConversationInput {
  return { question: c.q, context: c.previous ? { question: c.previous, answer: "이전 답변은 조회 근거가 아닙니다." } : undefined,
    date: "2026-11-01", nowMs: now, favoriteTeam: null, games: [],
    teamNames: { question: mentionedTeamCanonicals(c.q), context_question: mentionedTeamCanonicals(c.previous ?? ""), profile: [] },
    teamCandidates: conversationTeamCandidates(c.q, c.previous),
    appFacts: { tomorrow: { date: "2026-11-02", games: [] }, standings: { season: 2026, fetchedAt: new Date(now).toISOString(),
      rows: [{ teamId: 10, teamName: "키움", games: 144, wins: 50, losses: 90, draws: 4, ranking: 10, winRate: .357, gamesBehind: 30 }] } },
  };
}
function plan(i: GameConversationInput, scenario: boolean) {
  return { action: "app_facts", evidenceSource: "none", attendanceEvidence: "",
    appRequest: { informationNeed: scenario ? "scenario_outcome" : "team_standing", kind: scenario ? "none" : "standings",
      period: scenario ? "unsupported" : "current", quote: i.question, intentSource: "question", intentQuote: i.question },
    target: { source: "question", quote: i.question, teams: ["키움"], excludedTeams: [], backgroundTeams: [], stadium: "", excludedStadiums: [],
      mentions: i.teamCandidates!.filter(c => c.source === "question" && c.canonical === "키움").map(c => ({ id: c.id, referent: "baseball_team", role: "target" })) } };
}
function check(c: Case, value: Record<string, unknown>, result: ReturnType<typeof renderGameConversation>) {
  const req = value.appRequest as Record<string, unknown>;
  if (c.need === "not_app") {
    assert.equal(value.action, "other");
    assert.notEqual(req?.informationNeed, "scenario_outcome");
    assert.equal(result, null, "unsupported request must not render observed standings or a scenario hold");
    return;
  }
  assert.equal(value.action, "app_facts");
  if (c.need === "qualification_or_standing") {
    assert.ok(["qualification", "team_standing"].includes(String(req.informationNeed)));
    assert.doesNotMatch(result?.answer ?? "", /선수 구성 변화/);
    return; // Do not grade numerical standings from synthetic/missing team rows.
  }
  assert.equal(req.informationNeed, c.need);
  if (c.need === "scenario_outcome") {
    assert.equal(result?.source, "history_hold"); assert.match(result!.answer, /가정/);
    const [explanation, reference] = result!.answer.split("참고 — 실제 현재 순위 (가정의 결과가 아닙니다)");
    assert.doesNotMatch(explanation, /10위|50승|앱 순위표/);
    if (reference) assert.match(reference, /확인한 앱 순위표/);
  } else {
    assert.equal(result?.source, "kbo_structured");
    if (c.need === "team_standing") assert.match(result!.answer, /키움: 10위/);
    if (c.need === "match_prediction") assert.match(result!.answer, /2026-11-02/);
  }
}
async function main() {
  const i = input(cases.find(c => c.id === "observed-3242076")!);
  const before = renderGameConversation(JSON.stringify(plan(i, false)), i, { isBare: isBareTeamName });
  const after = renderGameConversation(JSON.stringify(plan(i, true)), i, { isBare: isBareTeamName });
  assert.match(before!.answer, /키움: 10위/, "old representable plan substitutes observed standings");
  check(cases.find(c => c.id === "observed-3242076")!, plan(i, true), after);
  assert.match(after!.answer, /참고 — 실제 현재 순위 \(가정의 결과가 아닙니다\)[\s\S]*키움: 10위/);
  const stale = { ...i, nowMs: now + 24 * 60 * 60 * 1000 };
  const noReference = renderGameConversation(JSON.stringify(plan(i, true)), stale, { isBare: isBareTeamName });
  assert.doesNotMatch(noReference!.answer, /10위|50승|앱 순위표/);
  assert.match(noReference!.answer, /현재 순위도 확인하지 못/);
  assert.equal(renderGameConversation(JSON.stringify({ ...plan(i, true), appRequest: { ...plan(i, true).appRequest, intentQuote: "원문에 없는 근거" } }), i), null);
  let stored: LlmResult | null = null, started = false;
  const deps: QaDeps = {
    loadGlossary: async () => [], loadPlayers: async () => [], getCache: async () => null,
    setCache: async () => { throw new Error("scenario hold must not enter shared cache"); },
    reserveDaily: async () => ({ allowed: true, remaining: 9 }), log: async () => {}, now: () => now,
    getLlmState: async () => ({ started, result: stored }), acquireLlmStart: async () => { started = true; return true; }, storeLlm: async result => { stored = result; },
    loadGameConversation: async () => ({ favoriteTeam: null, games: i.games, appFacts: i.appFacts }),
    callGameConversation: async () => ({ text: JSON.stringify(plan(i, true)), inputTokens: 1, outputTokens: 1 }),
    callLlm: async () => { throw new Error("scenario hold must not fall through to generated facts"); },
  };
  const result = await answerQuestion("qa-scenario-synthetic", i.question, deps);
  assert.equal(result.source, "history_hold"); assert.equal(result.answer, after!.answer);
  assert.deepEqual(await answerQuestion("qa-scenario-synthetic", i.question, deps), result);
  console.log(JSON.stringify({ mode: "deterministic", before, after, durable: true }));
  if (!process.argv.includes("--live")) return;
  const arg = (name: string) => process.argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!arg("base-root") || !arg("out")) throw new Error("live requires --base-root and --out");
  const results: unknown[] = []; let failures = 0;
  for (const [variant, root] of [["base", arg("base-root")!], ["head", path.resolve(import.meta.dirname, "../..")]]) {
    const { callGameConversation } = await import(pathToFileURL(path.join(root, "src/lib/baseball-qa/server.ts")).href);
    const { renderGameConversation: render } = await import(pathToFileURL(path.join(root, "src/lib/baseball-qa/game-conversation.ts")).href);
    for (const c of cases) for (let repeat = 0; repeat < 3; repeat++) {
      let record: Record<string, unknown> = { variant, id: c.id, repeat };
      try {
        const request = input(c); const raw = await callGameConversation(request); const value = JSON.parse(raw.text);
        const rendered = render(raw.text, request, { isBare: isBareTeamName });
        record = { ...record, value, rendered };
        check(c, value, rendered); record.pass = true;
      } catch (error) { record.pass = false; record.error = error instanceof Error ? error.message : String(error); if (variant === "head") failures++; }
      results.push(record); fs.writeFileSync(arg("out")!, JSON.stringify(results, null, 2));
    }
  }
  console.log(JSON.stringify({ mode: "live", rows: results.length, headFailures: failures }));
  assert.equal(failures, 0, "live head semantic regressions must be independently reviewed");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
