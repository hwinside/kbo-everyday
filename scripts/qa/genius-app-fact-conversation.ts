import assert from "node:assert/strict";
import { answerQuestion, type QaDeps, type LlmResult, mentionedTeamCanonicals } from "../../src/lib/baseball-qa/pipeline";
import { renderGameConversation, type GameConversationInput } from "../../src/lib/baseball-qa/game-conversation";

const now = Date.parse("2026-09-30T10:00:00Z");
const todayGame = { awayName: "KT", homeName: "삼성", stadium: "대구", time: "18:30", status: "scheduled",
  awayStarterName: "오늘KT선발", homeStarterName: "오늘삼성선발", starterSourceOk: true };
const tomorrowGame = { ...todayGame, awayName: "두산", homeName: "KT", stadium: "수원", time: "17:00",
  awayStarterName: "내일두산선발", homeStarterName: "내일KT선발" };
const snapshot: GameConversationInput = {
  question: "삼성 일정 말해줘", date: "2026-09-30", nowMs: now, favoriteTeam: null,
  games: [todayGame], teamNames: { question: ["삼성"], context_question: [], profile: [] },
  appFacts: { tomorrow: { date: "2026-10-01", games: [tomorrowGame] },
    standings: { fetchedAt: "2026-09-30T09:59:00Z", season: 2026, rows: [
      { teamName: "두산", teamId: 2, games: 130, wins: 70, losses: 58, draws: 2, ranking: 5, winRate: .547, gamesBehind: 7 },
    ] } },
};
function proposal(question: string, kind: string, period: string, teams: string[]) {
  return { action: "app_facts", evidenceSource: "none", attendanceEvidence: "",
    appRequest: { kind, period, quote: question }, target: { source: teams.length ? "question" : "none", quote: teams.length ? question : "",
      teams, excludedTeams: [], backgroundTeams: [], stadium: "", excludedStadiums: [] } };
}
const cases = [
  { q: "오늘 삼성과 kt경기 예측", kind: "prediction", period: "today", teams: ["삼성", "KT"], includes: /승패를 예측해 단정할 수는 없지만/, source: "kbo_structured" },
  { q: "야잘알이면 경기예측도 할 줄 알아야지", kind: "prediction", period: "current", teams: [], includes: /KT vs 삼성/, source: "kbo_structured" },
  { q: "고객님의물품이국제운송접수가완료되었습니다 삼성라이온즈 1번타자 누구?", kind: "lineup", period: "current", teams: ["삼성"], includes: /과거 라인업으로 대신 답하지 않겠습니다/, source: "history_hold" },
  { q: "삼성 일정 말해줘", kind: "schedule", period: "current", teams: ["삼성"], includes: /2026-09-30 경기 일정/, source: "kbo_structured" },
  { q: "내일 케이티 투수 ㄴㄱ?", kind: "starters", period: "tomorrow", teams: ["KT"], includes: /KT 내일KT선발/, source: "kbo_structured" },
  { q: "두산 이제 가을감?", kind: "postseason", period: "current", teams: ["두산"], includes: /두산: 5위, 70승 58패 2무/, source: "kbo_structured" },
];

export async function checkAppFactConversation() {
  for (const c of cases) {
    let stored: LlmResult | null = null, started = false, calls = 0;
    const logs: string[] = [];
    const deps: QaDeps = {
      loadGlossary: async () => [], loadPlayers: async () => [],
      getCache: async () => null, setCache: async () => { throw new Error("app facts must not enter shared cache"); },
      reserveDaily: async () => ({ allowed: true, remaining: 9 }), now: () => now,
      log: async (row) => { logs.push(row.matchPath); },
      getLlmState: async () => ({ started, result: stored }),
      acquireLlmStart: async () => { if (started) return false; started = true; return true; },
      storeLlm: async (result) => { stored = result; },
      loadGameConversation: async () => snapshot,
      callGameConversation: async (input) => {
        calls++; assert.deepEqual(input.teamNames.question, c.teams);
        return { text: JSON.stringify(proposal(c.q, c.kind, c.period, c.teams)), inputTokens: 2, outputTokens: 3 };
      },
      callLlm: async () => { throw new Error("must not generate historical prose"); },
      enableTeamRag: true,
      searchRag: async () => { throw new Error("must not retrieve old team docs"); },
      callTeamRagLlm: async () => { throw new Error("must not generate team prose"); },
    };
    const first = await answerQuestion("qa-app-facts", c.q, deps);
    assert.equal(first.source, c.source, c.q); assert.match(first.answer ?? "", c.includes, c.q);
    assert.ok(stored, "structured final must be durable"); assert.equal(calls, 1);
    deps.loadGameConversation = async () => { throw new Error("stored result must precede changed data"); };
    const replay = await answerQuestion("qa-app-facts", c.q, deps);
    assert.equal(replay.answer, first.answer); assert.equal(replay.source, first.source); assert.equal(calls, 1);
    assert.deepEqual(logs, [c.source, c.source]);
  }
  const q = "내일 케이티 투수 ㄴㄱ?";
  const input = { ...snapshot, question: q, teamNames: { ...snapshot.teamNames, question: ["KT"] } };
  const p = proposal(q, "starters", "tomorrow", ["KT"]);
  const render = (i: GameConversationInput, plan = p) => renderGameConversation(JSON.stringify(plan), i)!;
  assert.doesNotMatch(render(input).answer, /오늘KT선발|오늘삼성선발|내일두산선발/);
  for (const [games, pattern] of [[null, /조회하지 못/], [[], /등록된 경기가 없습니다/],
    [[{ ...tomorrowGame, homeStarterName: "" }], /KT 미발표/],
    [[{ ...tomorrowGame, starterSourceOk: false }], /출처를 확인하지 못/],
    [[{ ...tomorrowGame, status: "cancelled" }], /취소 경기/]] as const) {
    const result = render({ ...input, appFacts: { ...input.appFacts!, tomorrow: { date: "2026-10-01", games: games === null ? null : [...games] } } });
    assert.match(result.answer, pattern); assert.doesNotMatch(result.answer, /오늘KT선발/);
  }
  const mismatched = render({ ...input, appFacts: { ...input.appFacts!, tomorrow: { date: "2026-09-30", games: [todayGame] } } });
  assert.match(mismatched.answer, /조회하지 못/);
  assert.equal(render(input, { ...p, target: { ...p.target, teams: ["LG"] } }).source, "context_missing");
  assert.equal(renderGameConversation(JSON.stringify({ ...p, appRequest: { ...p.appRequest, quote: "invented" } }), input), null);
  assert.match(render(input, { ...p, appRequest: { ...p.appRequest, period: "unsupported" } }).answer, /기간을 이 범위로 바꾸어/);
  const standingInput = { ...snapshot, question: "두산 이제 가을감?", teamNames: { ...snapshot.teamNames, question: ["두산"] } };
  const standingPlan = proposal(standingInput.question, "postseason", "current", ["두산"]);
  for (const patch of [{ season: 2025 }, { fetchedAt: undefined }, { fetchedAt: "2026-09-30T08:00:00Z" },
    { fetchedAt: "2026-09-30T10:01:00Z" }, { rows: [] }]) {
    const result = renderGameConversation(JSON.stringify(standingPlan), { ...standingInput,
      appFacts: { ...snapshot.appFacts!, standings: { ...snapshot.appFacts!.standings!, ...patch } } })!;
    assert.equal(result.source, "history_hold"); assert.doesNotMatch(result.answer, /5위/);
  }
  const pair = { ...snapshot, question: "오늘 삼성과 두산 경기 예측", teamNames: { ...snapshot.teamNames, question: ["삼성", "두산"] } };
  assert.doesNotMatch(renderGameConversation(JSON.stringify(proposal(pair.question, "prediction", "today", ["삼성", "두산"])), pair)!.answer, /KT vs 삼성/);
  const dh = { ...snapshot, games: [todayGame, { ...todayGame, time: "20:00" }] };
  assert.match(renderGameConversation(JSON.stringify(proposal(dh.question, "schedule", "today", ["삼성"])), dh)!.answer, /20:00/);
  // Real lexical entity resolver remains the authority, not model-proposed team names.
  assert.deepEqual(mentionedTeamCanonicals("내일 케이티 투수 ㄴㄱ?"), ["KT"]);
}
