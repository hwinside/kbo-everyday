/** Reviewer-run deterministic contract; semantic correctness needs live base/head replay. */
import assert from "node:assert/strict";
import { answerQuestion, classifyQuestionCorrectionCandidate, conversationTeamCandidates, mentionedTeamCanonicals, isBareTeamName, type QaDeps, type LlmResult } from "../../src/lib/baseball-qa/pipeline";
import { permitsGlossaryRepair, permitsLexicalCorrection } from "../../src/lib/baseball-qa/correction-term-identity";
import { gameConversationRequest, renderGameConversation, type GameConversationInput } from "../../src/lib/baseball-qa/game-conversation";

assert.equal(permitsGlossaryRepair("보끄가 뭐야?"), true, "provider outage/missing assessment preserves closed-glossary repair");
for (const status of ["valid", "unknown"] as const) {
  assert.equal(permitsGlossaryRepair("내일은?", { status, quote: "" }, "포일은?"), false);
}
assert.equal(permitsGlossaryRepair("보끄와 콜드", { status: "typo", quote: "보끄" }, "보크와 홀드"), false);

const glossary = [{ term: "포일", aliases: [], answer: "포수가 잡을 수 있는 공을 놓치는 것입니다." }];
for (const q of ["내일은?", "그럼 내일은요?", "위닝", "콜드", "아하", "삼성", "새로운 정상 단어"]) {
  assert.equal(permitsLexicalCorrection(q, { status: "valid", quote: q }), false);
  assert.equal(permitsLexicalCorrection(q, { status: "unknown", quote: q }), false);
  assert.equal(permitsLexicalCorrection(q), false);
  assert.equal(permitsLexicalCorrection(q, { status: "typo", quote: "원문에 없는 인용" }), false);
}
assert.equal(permitsLexicalCorrection("보끄가 뭐야?", { status: "typo", quote: "보끄" }), true);
assert.equal(classifyQuestionCorrectionCandidate("내일은?", "내일은 ?", glossary, []), "accepted_surface");
assert.equal(classifyQuestionCorrectionCandidate("보끄가 뭐야?", "보크가 뭐야?", [{ term: "보크", aliases: [], answer: "투수 반칙" }], []), "suggest");

assert.equal(permitsLexicalCorrection("투구가 뭔가용", { status: "typo", quote: "뭔가용" }, "투심가 뭔가요"), false);
assert.equal(permitsLexicalCorrection("투구가 뭔가용", { status: "typo", quote: "뭔가용" }, "투구가 뭔가요"), true);
assert.equal(permitsLexicalCorrection("보끄 보끄", { status: "typo", quote: "보끄" }, "보크 보끄"), false);

const now = Date.parse("2026-10-01T10:00:00Z");
const today = { awayName: "NC", homeName: "두산", stadium: "잠실", time: "18:30", status: "scheduled", starterSourceOk: true, awayStarterName: "오늘NC투수", homeStarterName: "오늘두산투수" };
const tomorrow = { ...today, awayName: "한화", homeName: "삼성", stadium: "대구", awayStarterName: "내일한화투수", homeStarterName: "내일삼성투수" };
function plan(input: GameConversationInput, team: string, temporal: boolean) {
  return { action: "app_facts", evidenceSource: "none", attendanceEvidence: "",
    appRequest: { informationNeed: "starting_pitchers", kind: "starters", period: temporal ? "tomorrow" : "today", quote: input.question,
      intentSource: temporal ? "context_question" : "question", intentQuote: temporal ? input.context!.question : "선발은" },
    target: { source: "context_question", quote: input.context!.question, teams: [team], excludedTeams: [], backgroundTeams: [], stadium: "", excludedStadiums: [],
      mentions: input.teamCandidates!.filter(c => c.source === "context_question" && c.canonical === team).map(c => ({ id: c.id, referent: "baseball_team", role: "target" })) } };
}
async function main() {
  for (const temporal of [false, true]) {
    const question = temporal ? "내일은?" : "그럼 거기 선발은?";
    const previous = temporal ? "오늘 한화경기 선발 누구야?" : "오늘 두산경기 몇시였어?";
    const team = temporal ? "한화" : "두산";
    let stored: LlmResult | null = null, started = false, correctionCalls = 0, selectorCalls = 0;
    const deps: QaDeps = {
      loadGlossary: async () => glossary, loadPlayers: async () => [], getCache: async () => null,
      setCache: async () => { throw new Error("app facts must not use shared cache"); },
      reserveDaily: async () => ({ allowed: true, remaining: 9 }), log: async () => {}, now: () => now,
      normalizeQuestionLlm: async () => { correctionCalls++; return { text: temporal ? "포일은?" : null, originalSpelling: { status: "valid", quote: "" }, inputTokens: 0, outputTokens: 0 }; },
      loadPreviousTurn: async () => ({ question: previous, answer: "NC와 두산 경기. 이 답변의 상대팀은 대상 근거가 아닙니다.", jobSource: "kbo_structured", answeredAt: new Date(now - 1000).toISOString(), currentCreatedAt: new Date(now).toISOString() }),
      getLlmState: async () => ({ started, result: stored }), acquireLlmStart: async () => { started = true; return true; }, storeLlm: async result => { stored = result; },
      loadGameConversation: async () => ({ favoriteTeam: null, games: [today], appFacts: { tomorrow: { date: "2026-10-02", games: [tomorrow] }, standings: null } }),
      callGameConversation: async input => { selectorCalls++; assert.equal(input.question, question); assert.equal(input.context?.question, previous); return { text: JSON.stringify(plan(input, team, temporal)), inputTokens: 1, outputTokens: 1 }; },
      callLlm: async () => { throw new Error("structured facts must not become generic prose"); },
    };
    const result = await answerQuestion("qa-deictic-temporal", question, deps);
    assert.equal(result.source, "kbo_structured"); assert.equal(selectorCalls, 1);
    assert.match(result.answer!, temporal ? /한화 내일한화투수/ : /두산 오늘두산투수/);
    assert.doesNotMatch(result.answer!, temporal ? /오늘두산투수|포일/ : /선발: NC|어느 구단/);
    if (temporal) assert.equal(correctionCalls, 1, "valid original must reject both provider substitution and glossary fallback");
    assert.ok(stored, "answer must remain durable");
    assert.deepEqual(await answerQuestion("qa-deictic-temporal", question, deps), result);
  }
  // The actual bad provider shape remains rejected; never launder the added opponent.
  const previous = "오늘 두산경기 몇시였어?", question = "그럼 거기 선발은?";
  const input: GameConversationInput = { question, context: { question: previous, answer: "NC vs 두산" }, date: "2026-10-01", favoriteTeam: null, games: [today],
    teamNames: { question: [], context_question: mentionedTeamCanonicals(previous), profile: [] }, teamCandidates: conversationTeamCandidates(question, previous) };
  const request = gameConversationRequest(input);
  const modelInput = JSON.parse(request.contents[0].parts[0].text);
  assert.deepEqual(modelInput.context, { question: previous });
  for (const key of ["games", "appFacts"]) assert.equal(Object.hasOwn(modelInput, key), false);
  assert.ok(request.generationConfig.responseSchema.properties.target.required.includes("mentions"));
  const good = plan(input, "두산", false);
  const render = (p: unknown, i = input) => renderGameConversation(JSON.stringify(p), i, { isBare: isBareTeamName });
  assert.equal(render(good)?.source, "kbo_structured");
  assert.equal(render({ ...good, target: { ...good.target, teams: ["NC", "두산"] } })?.source, "context_missing");
  assert.equal(render(good, { ...input, context: undefined }), null);
  assert.equal(render({ ...good, target: { ...good.target, mentions: [] } })?.source, "context_missing");
  console.log("deictic/temporal pipeline + provenance contract PASS; live semantic replay still required");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
