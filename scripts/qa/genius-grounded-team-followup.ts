import assert from "node:assert/strict";
import { conversationTeamCandidates, mentionedTeamCanonicals, isBareTeamName } from "../../src/lib/baseball-qa/pipeline";
import { gameConversationRequest, renderGameConversation, type GameConversationInput } from "../../src/lib/baseball-qa/game-conversation";

const prior = "오늘 한화경기 선발 누구였어)";
const question = "그럼 타자들은 누구였어?";
function inputFor(previous = prior, current = question): GameConversationInput {
  return { question: current, context: { question: previous, answer: "이 답변의 한화라는 글자는 대상 근거가 아닙니다." },
    date: "2026-10-01", favoriteTeam: null,
    games: [{ awayName: "한화", homeName: "삼성", stadium: "대구", time: "18:30", status: "scheduled" },
      { awayName: "LG", homeName: "KT", stadium: "수원", time: "18:30", status: "scheduled" }],
    teamNames: { question: mentionedTeamCanonicals(current), context_question: mentionedTeamCanonicals(previous), profile: [] },
    teamCandidates: conversationTeamCandidates(current, previous) };
}
function proposal(input: GameConversationInput, source = "context_question", teams = ["한화"]) {
  return { action: "app_facts", evidenceSource: "none", attendanceEvidence: "",
    appRequest: { kind: "lineup", informationNeed: "batting_order", period: "today", quote: input.question,
      intentSource: "question", intentQuote: input.question },
    target: { source, quote: "", teams, excludedTeams: [] as string[], backgroundTeams: [] as string[], stadium: "", excludedStadiums: [],
      mentions: input.teamCandidates!.map((c) => ({ id: c.id, referent: "baseball_team", role: c.source === source ? "target" : "unused" })) } };
}
const input = inputFor();
const good = proposal(input);
const render = (p: unknown, i = input) => renderGameConversation(JSON.stringify(p), i, { isBare: isBareTeamName });
assert.deepEqual(input.teamNames.context_question, []); // actual pre-fix boundary
assert.equal(input.teamCandidates?.[0].token, "한화경기");
assert.equal(render(good)?.source, "history_hold");
assert.match(render(good)!.answer, /한화 vs 삼성/);
assert.match(render(good)!.answer, /타순·타자 라인업/);
assert.doesNotMatch(render(good)!.answer, /LG vs KT|어느 구단/);
// No entire original/segmented quote is required: the selected server ID owns it.
assert.equal(good.target.quote, "");
for (const mentions of [undefined, [], [...good.target.mentions, ...good.target.mentions],
  [{ ...good.target.mentions[0], id: "context_question:999:한화" }],
  [{ ...good.target.mentions[0], referent: "unknown", role: "unused" }],
  [{ ...good.target.mentions[0], referent: "non_team" }]]) {
  assert.equal(render({ ...good, target: { ...good.target, mentions } })?.source, "context_missing");
}
assert.equal(render(good, { ...input, context: undefined })?.source, "context_missing");
assert.equal(render(good, { ...input, context: { question: "한화생명", answer: "" } })?.source, "context_missing");
assert.equal(render({ ...good, target: { ...good.target, source: "question" } })?.source, "context_missing");
assert.equal(render({ ...good, target: { ...good.target, teams: ["LG"] } })?.source, "context_missing");
// Company words are whole candidates, never deterministic team admissions.
for (const company of ["한화생명", "삼성전자", "기아자동차", "롯데마트", "두산에너빌리티", "LG전자", "KT클라우드", "NC소프트"]) {
  const i = inputFor(`${company} 영업시간 알려줘`);
  assert.equal(i.teamNames.context_question.length, 0);
  assert.ok(i.teamCandidates!.some((c) => c.token === company));
  const p = proposal(i);
  p.target.quote = company;
  p.target.mentions = p.target.mentions.map((m) => ({ ...m, referent: "non_team", role: "unused" }));
  assert.equal(render(p, i)?.source, "context_missing"); // forged canonical not grounded
  const fresh = { ...p, target: { ...p.target, source: "none", teams: [] } };
  assert.equal(render(fresh, i)?.source, "history_hold"); // preserve new all-game request
}
for (const q of ["LG 타자들은?", "LG경기 타자들은?"]) {
  const i = inputFor(prior, q);
  const p = proposal(i, "question", ["LG"]);
  p.target.quote = q;
  assert.match(render(p, i)!.answer, /LG vs KT/);
  assert.doesNotMatch(render(p, i)!.answer, /한화 vs 삼성/);
}
// Missing/invented/irrelevant mention rows never veto resolver or source=none.
const noisyMentions = [undefined, [], [{ id: "LG", referent: "baseball_team", role: "target" }],
  [{ id: "invented", referent: "unknown", role: "target" }], [...good.target.mentions, ...good.target.mentions]];
for (const mentions of noisyMentions) {
  for (const q of ["LG 타자들은?", "삼성 타자들은?", "오늘 한화 경기 선발 누구야?"]) {
    const i = inputFor(prior, q);
    const p = proposal(i, "question", i.teamNames.question);
    assert.notEqual(render({ ...p, target: { ...p.target, mentions } }, i)?.source, "context_missing");
    assert.equal(render({ ...p, target: { ...p.target, mentions } }, i)?.source, "history_hold");
  }
  for (const company of ["한화생명", "두산에너빌리티", "LG전자", "KT클라우드", "NC소프트", "KTX"]) {
    const i = inputFor(`${company} 영업시간`, "오늘 경기 선수 누구누구였어?");
    const p = proposal(i, "none", []);
    assert.equal(render({ ...p, target: { ...p.target, mentions } }, i)?.source, "history_hold");
  }
}
// Zero candidates do not make invented IDs meaningful.
const lexical = inputFor("안녕", "오늘 한화 경기 선발 누구야?");
assert.equal(lexical.teamCandidates!.length, 0);
const lexicalPlan = proposal(lexical, "question");
assert.equal(render({ ...lexicalPlan, target: { ...lexicalPlan.target,
  mentions: [{ id: "한화", referent: "baseball_team", role: "target" }] } }, lexical)?.source, "history_hold");
// Candidate-dependent teams still require the exact role; unrelated IDs are ignored.
assert.equal(render({ ...good, target: { ...good.target,
  mentions: [...good.target.mentions, { id: "invented", referent: "unknown", role: "unused" }] } })?.source, "history_hold");
assert.equal(render({ ...good, target: { ...good.target,
  mentions: good.target.mentions.map((m) => ({ ...m, role: "background" })) } })?.source, "context_missing");
const mixed = inputFor(prior, "LG경기 말고 한화경기 타자들은?");
const excluded = proposal(mixed, "question");
excluded.target.excludedTeams = ["LG"];
excluded.target.mentions = excluded.target.mentions.map((m) => ({ ...m,
  role: m.id.startsWith("question:") && m.id.endsWith(":LG") ? "excluded" : m.role }));
assert.match(render(excluded, mixed)!.answer, /한화 vs 삼성/);
assert.doesNotMatch(render(excluded, mixed)!.answer, /LG vs KT/);
const req = gameConversationRequest(input);
assert.ok(JSON.stringify(req).includes('teamCandidates'));
assert.ok(JSON.stringify(req).includes('mentions'));
console.log("PASS grounded team candidate IDs, source binding, current-team priority and company contract");
