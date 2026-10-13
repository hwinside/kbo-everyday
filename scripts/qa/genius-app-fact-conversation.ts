import assert from "node:assert/strict";
import { answerQuestion, type QaDeps, type LlmResult, mentionedTeamCanonicals, isBareTeamName } from "../../src/lib/baseball-qa/pipeline";
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
    appRequest: { informationNeed: ({ schedule: "game_schedule", starters: "starting_pitchers", standings: "team_standing", postseason: "qualification", lineup: "batting_order", prediction: "match_prediction" } as Record<string, string>)[kind], kind, period, quote: question, intentSource: "question", intentQuote: question }, target: { source: teams.length ? "question" : "none", quote: teams.length ? question : "",
      teams, excludedTeams: [], backgroundTeams: [], stadium: "", excludedStadiums: [] } };
}
const cases = [
  { q: "오늘 경기 일정 알려줘", kind: "schedule", period: "today", teams: [], includes: /KT vs 삼성/, source: "kbo_structured" },
  { q: "삼성 경기 몇 시에 시작해?", kind: "schedule", period: "today", teams: ["삼성"], includes: /18:30/, source: "kbo_structured" },
  { q: "오늘 삼성과 kt경기 예측", normalized: "오늘 삼성과 KT 경기 예측", kind: "prediction", period: "today", teams: ["삼성", "KT"], includes: /승패를 예측해 단정할 수는 없지만/, source: "kbo_structured" },
  { q: "야잘알이면 경기예측도 할 줄 알아야지", kind: "prediction", period: "current", teams: [], includes: /KT vs 삼성/, source: "kbo_structured" },
  { q: "고객님의물품이국제운송접수가완료되었습니다 삼성라이온즈 1번타자 누구?", kind: "lineup", period: "current", teams: ["삼성"], includes: /과거 라인업으로 대신 답하지 않겠습니다/, source: "history_hold" },
  { q: "삼성 일정 말해줘", kind: "schedule", period: "current", teams: ["삼성"], includes: /2026-09-30 경기 일정/, source: "kbo_structured" },
  { q: "내일 케이티 투수 ㄴㄱ?", kind: "starters", period: "tomorrow", teams: ["KT"], includes: /KT 내일KT선발/, source: "kbo_structured" },
  { q: "두산 이제 가을감?", kind: "postseason", period: "current", teams: ["두산"], includes: /두산: 5위, 70승 58패 2무/, source: "kbo_structured" },
];

export async function checkAppFactConversation() {
  // Mirror the production spelling-normalization port; the lexical resolver does
  // not split kt경기 itself. Never invent the second team in the selector stub.
  assert.deepEqual(mentionedTeamCanonicals("오늘 삼성과 kt경기 예측"), ["삼성"]);
  for (const c of cases) {
    let stored: LlmResult | null = null, started = false, calls = 0;
    const logs: string[] = [];
    const deps: QaDeps = {
      loadGlossary: async () => [], loadPlayers: async () => [],
      normalizeQuestionLlm: async () => ({ text: c.normalized ?? null, inputTokens: 0, outputTokens: 0 }),
      getCache: async () => null, setCache: async () => { throw new Error("app facts must not enter shared cache"); },
      reserveDaily: async () => ({ allowed: true, remaining: 9 }), now: () => now,
      log: async (row) => { logs.push(row.matchPath); },
      getLlmState: async () => ({ started, result: stored }),
      acquireLlmStart: async () => { if (started) return false; started = true; return true; },
      storeLlm: async (result) => { stored = result; },
      loadGameConversation: async () => ({ ...snapshot, date: "1999-01-01", nowMs: 0 }),
      callGameConversation: async (input) => {
        calls++; assert.equal(input.question, c.normalized ?? c.q, "snapshot cannot overwrite current question");
        assert.equal(input.date, "2026-09-30"); assert.equal(input.nowMs, now);
        assert.deepEqual(input.teamNames.question, c.teams);
        return { text: JSON.stringify(proposal(input.question, c.kind, c.period, [])), inputTokens: 2, outputTokens: 3 };
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
  // A requested event date must not become a current standings answer, even
  // when the provider proposes the old erroneous postseason capability.
  const eventInput = { ...snapshot, question: "가을야구는 언제 시작해", teamNames: { question: [], context_question: [], profile: [] } };
  const eventPlan = proposal(eventInput.question, "postseason", "current", []);
  for (const informationNeed of ["event_date", "game_schedule", "none", "invented", undefined]) {
    assert.equal(renderGameConversation(JSON.stringify({ ...eventPlan,
      appRequest: { ...eventPlan.appRequest, informationNeed } }), eventInput), null);
  }
  // App targets come from current resolver entities, not a model's attendance source.
  const q = "내일 케이티 투수 ㄴㄱ?";
  const input = { ...snapshot, question: q, teamNames: { ...snapshot.teamNames, question: ["KT"] } };
  const p = proposal(q, "starters", "tomorrow", ["KT"]);
  const render = (i: GameConversationInput, plan = p) => renderGameConversation(JSON.stringify(plan), i)!;
  assert.match(render(input, proposal(q, "starters", "tomorrow", [])).answer, /KT 내일KT선발/);
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
  const roleInput = { ...snapshot, question: "두산 팬인데 삼성 일정 알려줘", teamNames: { ...snapshot.teamNames, question: ["두산", "삼성"] } };
  const rolePlan = proposal(roleInput.question, "schedule", "today", ["삼성"]);
  assert.match(renderGameConversation(JSON.stringify({ ...rolePlan, target: { ...rolePlan.target, backgroundTeams: ["두산"] } }), roleInput)!.answer, /KT vs 삼성/);
  const exceptInput = { ...snapshot, question: "삼성 말고 오늘 일정 알려줘" };
  const exceptPlan = proposal(exceptInput.question, "schedule", "today", []);
  assert.doesNotMatch(renderGameConversation(JSON.stringify({ ...exceptPlan, target: { ...exceptPlan.target, source: "question", quote: exceptInput.question, excludedTeams: ["삼성"] } }), exceptInput)!.answer, /KT vs 삼성/);
  // Real lexical entity resolver remains the authority, not model-proposed team names.
  assert.deepEqual(mentionedTeamCanonicals("내일 케이티 투수 ㄴㄱ?"), ["KT"]);
}

// #1505 P1: intent grounding; model-generated spacing is not entity evidence.
{
  const entities = { resolve: mentionedTeamCanonicals, isBare: isBareTeamName };
  const render = (plan: unknown, input: GameConversationInput) => renderGameConversation(JSON.stringify(plan), input, entities);
  for (const q of ["두산", "기아", "KIA", "한화 이글스"]) {
    const names = mentionedTeamCanonicals(q);
    const input = { ...snapshot, question: q, teamNames: { ...snapshot.teamNames, question: names } };
    const plan = proposal(q, "schedule", "current", names);
    assert.equal(render(plan, input), null, "a bare team is not schedule intent");
    assert.equal(render({ ...plan, appRequest: { ...plan.appRequest, intentSource: "none", intentQuote: "" } }, input), null);
  }
  const q = "오늘 경기 선수 누구누구였어?";
  const prior = "오늘 한화경기 선발 누구였어)";
  const input: GameConversationInput = { ...snapshot, question: q,
    context: { question: prior, answer: "직전 선발 안내" },
    games: [todayGame, { ...todayGame, awayName: "한화", homeName: "롯데" }],
    teamNames: { question: [], context_question: mentionedTeamCanonicals(prior), profile: [] } };
  const plan = proposal(q, "lineup", "today", ["한화"]);
  const followup = { ...plan, target: { ...plan.target, source: "context_question", quote: "한화",
    segmentedSource: "오늘 한화 경기 선발 누구였어)" } };
  const result = render(followup, input)!;
  assert.equal(result.source, "context_missing", "spacing-only context repair is deferred; do not trust model-added teams");
  assert.doesNotMatch(result.answer, /한화 vs 롯데|KT vs 삼성|선발:/);
  for (const segmentedSource of ["오늘 삼성 경기 선발 누구였어)", "오늘 한화 경기 선발 누구였어?", "한화"]) {
    assert.equal(render({ ...followup, target: { ...followup.target, segmentedSource } }, input)?.source, "context_missing");
  }
  // The real R0 selector returned only the team. It must remain rejected;
  // even a full copy must not grant entity authority after removing that path.
  for (const [company, team] of [["한화생명", "한화"], ["기아자동차", "KIA"], ["삼성전자", "삼성"]]) {
    const question = `${company} 영업시간 알려줘`;
    const companyInput = { ...input, context: { question, answer: "회사 안내" },
      teamNames: { ...input.teamNames, context_question: mentionedTeamCanonicals(question) } };
    assert.deepEqual(companyInput.teamNames.context_question, []);
    for (const segmentedSource of [question, team]) {
      assert.equal(render({ ...followup, target: { ...followup.target, quote: company,
        teams: [team], segmentedSource } }, companyInput)?.source, "context_missing");
    }
  }
  // An unrelated prior entity must not erase a current, explicit app request.
  // Empty target is valid: the renderer can show actual games + lineup limits.
  for (const priorQuestion of ["한화생명 영업시간 알려줘", "롯데마트 영업시간 알려줘", "두산에너빌리티 뭐하는 회사야?", "한화오션 뭐하는 회사야?"]) {
    const explicitInput = { ...input, context: { question: priorQuestion, answer: "회사 안내" },
      teamNames: { question: [], context_question: [], profile: [] } };
    const explicitPlan = proposal(q, "lineup", "today", []);
    const explicit = render(explicitPlan, explicitInput)!;
    assert.equal(explicit.source, "history_hold");
    assert.match(explicit.answer, /라인업|타순/);
    assert.match(explicit.answer, /KT vs 삼성/);
    assert.doesNotMatch(explicit.answer, /이 내용은 지금 정확히|어느 구단/);
  }
  // Model spacing repair is not authorized for either turn in this PR.
  const directInput = { ...input, question: prior, context: undefined };
  const directPlan = proposal(prior, "lineup", "today", ["한화"]);
  assert.equal(render({ ...directPlan, target: { ...followup.target, source: "question" } }, directInput)?.source, "context_missing");
  assert.equal(render(followup, { ...input, context: undefined }), null);
  assert.equal(render({ ...followup, appRequest: { ...followup.appRequest, intentQuote: "없는 요청" } }, input), null);
  const current = { ...input, question: "오늘 삼성 선수 누구였어?", teamNames: { ...input.teamNames, question: ["삼성"] } };
  const currentPlan = proposal(current.question, "lineup", "today", ["삼성"]);
  assert.doesNotMatch(render(currentPlan, current)!.answer, /한화 vs 롯데/);
  const teamFollowup = { ...snapshot, question: "두산", context: { question: "오늘 경기 일정 알려줘", answer: "일정 안내" },
    games: [{ ...todayGame, awayName: "두산" }], teamNames: { ...snapshot.teamNames, question: ["두산"] } };
  const schedule = proposal("두산", "schedule", "today", ["두산"]);
  assert.match(render({ ...schedule, appRequest: { ...schedule.appRequest,
    intentSource: "context_question", intentQuote: "경기 일정 알려줘" } }, teamFollowup)!.answer, /두산 vs 삼성/);
}

// A player status/date is not a game schedule, even if the provider proposes
// one of the supported app kinds. Player names are fixtures, not production rules.
{
  for (const question of ["문동주 언제와", "부상 선수는 언제 돌아올 수 있어?", "김도영 복귀 일정 알려줘"]) {
    const input = { ...snapshot, question, teamNames: { question: [], context_question: [], profile: [] } };
    for (const kind of ["schedule", "starters", "lineup"]) {
      const plan = proposal(question, kind, "today", []);
      assert.equal(renderGameConversation(JSON.stringify({ ...plan,
        appRequest: { ...plan.appRequest, informationNeed: "player_availability" } }), input), null);
    }
  }
}
