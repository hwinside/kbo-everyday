import primaryNewsBodies from "./fixtures/genius-primary-news-dates-20260929.json";
import { officialEventContracts } from "./genius-official-events";
import { boundedNewsContracts } from "./genius-bounded-news";
import { buildQuestionLogRow } from "../../src/lib/baseball-qa/log-row";
import assert from "node:assert/strict";
import { runVerifiedFallback, primaryNewsDateSupported, quoteSupportsNumbers, citationWithinQuestionDay, fallbackEligible } from "../../src/lib/baseball-qa/agent/fallback";
import { answerQuestion, validateLlmResponse, type QaDeps, type LlmResult, unpackStoredQaFinal } from "../../src/lib/baseball-qa/pipeline";
import type { AgentPorts, Evidence } from "../../src/lib/baseball-qa/agent/poc";
const input = { question: "아시안게임 야구 일정 알려줘", now: "2026-09-29T03:00:00Z", history: [] };
const evidence: Evidence = { id: "news:test", source: "news", title: "일정", content: "야구 대표팀은 대회 일정을 추후 발표할 예정입니다.", url: "https://sports.naver.com/news/1", asOf: input.now };
const claim = { text: evidence.content, citations: [{ id: evidence.id, quote: evidence.content }] };
function ports(options: { row?: Evidence; text?: string; quote?: string; verified?: boolean; temporal?: boolean; core?: boolean; sameDay?: boolean | null } = {}): AgentPorts {
  let turn = 0;
  return { search: async () => [options.row ?? evidence], decide: async () => ++turn === 1
    ? { action: "search", source: options.row?.source ?? evidence.source, query: input.question, terms: ["아시안게임"] }
    : turn === 2 ? { action: "answer", claims: [{ ...claim, text: options.text ?? claim.text, citations: [{ id: claim.citations[0].id, quote: options.quote ?? claim.citations[0].quote }] }] }
    : { supported: options.verified ?? true, temporalSupported: options.temporal ?? true, answersCore: options.core ?? true, ...(options.sameDay === null ? {} : { eventDateMatchesQuestion: options.sameDay ?? true }) } };
}
function deps(overrides: Partial<QaDeps> = {}): QaDeps {
  return { loadGlossary: async () => [], loadPlayers: async () => [], getCache: async () => null,
    setCache: async () => { throw new Error("fallback must not cache"); },
    reserveDaily: async () => ({ allowed: true, remaining: 9 }), log: async () => {},
    now: () => Date.parse(input.now),
    callLlm: async () => ({ text: JSON.stringify({ status: "UNSURE" }), inputTokens: 1, outputTokens: 1 }), ...overrides };
}
async function main() {
  await boundedNewsContracts();
  await officialEventContracts();
  const positive = await runVerifiedFallback(input, ports());
  assert.equal(await runVerifiedFallback(input, ports({ core: false })), null, "factually supported but not answering core question is rejected");
  assert.equal(await runVerifiedFallback(input, ports({ text: "제공된 자료에서는 일정을 확인할 수 없습니다." })), null, "internal retrieval language never served");
  assert.equal(await runVerifiedFallback(input, ports({ text: "개최일은 확인할 수 없으며 선수단 소집만 알려졌습니다." })), null, "camp/departure cannot substitute for schedule even if verifier approves");
  assert.equal(positive?.source, "news_rag");
  // R1: all model approvals are true; generic tournament updates must still reject previews.
  const preview = "곽빈이 선발로 예고되었습니다.";
  for (const question of ["아시안게임은?", "아시안게임 야구 어떻게 됐어?", "아시안게임 결과"]) {
    assert.equal(await runVerifiedFallback({ ...input, question, now: "2026-09-21T11:49:00Z" },
      ports({ row: { ...evidence, content: evidence.content + preview, asOf: "2026-09-21T08:00:00Z" }, text: preview, quote: preview })), null,
    "pregame starter preview cannot answer an in-progress tournament update");
  }
  assert.ok(await runVerifiedFallback({ ...input, question: "아시안게임 선발 누구?" },
    ports({ row: { ...evidence, content: preview }, text: preview, quote: preview })),
  "explicit starter query keeps the verifier path rather than blanket blocking previews");
  assert.equal(quoteSupportsNumbers("2026 아시안게임 금메달입니다.", "아시안게임 금메달입니다."), false, "do not relax uncited year guard");
  assert.equal(quoteSupportsNumbers("아시안게임 금메달입니다.", "아시안게임 금메달입니다."), true);
  assert.equal(quoteSupportsNumbers("9월 21일부터 27일까지입니다.", "9월 21일부터 27일까지"), true);
  // R2: an approving verifier cannot erase an explicit off-day departure date.
  const departure = "삼성 퓨처스팀은 10월 1일 일본 후쿠오카로 출발합니다.";
  const departureRow = { ...evidence, content: departure };
  for (const question of ["오늘 삼성 퓨처스팀 어디 가?", "어제 삼성 퓨처스팀 어디 가?"]) {
    const row = { ...departureRow, asOf: question.startsWith("어제") ? "2026-09-28T03:00:00Z" : input.now };
    for (const text of ["일본 후쿠오카로 향합니다.", "후쿠오카를 찾아 교류전을 갖습니다."]) {
      assert.equal(await runVerifiedFallback({ ...input, question }, ports({ row, text, quote: departure })), null,
        "off-day event date omission rejected even with all verifier approvals");
    }
    assert.ok(await runVerifiedFallback({ ...input, question }, ports({ row,
      text: "10월 1일 일본 후쿠오카로 출발할 예정입니다.", quote: departure, sameDay: false })),
      "explicit cited future date remains answerable");
    assert.equal(await runVerifiedFallback({ ...input, question }, ports({ row,
      text: "일본 후쿠오카로 출발합니다.", quote: "일본 후쿠오카로 출발합니다.", sameDay: false })), null,
      "cropping the event date from quote cannot bypass verifier off-day finding");
  }
  const sameDayText = "삼성 퓨처스팀은 9월 29일 일본 후쿠오카로 출발합니다.";
  assert.ok(await runVerifiedFallback({ ...input, question: "오늘 삼성 퓨처스팀 어디 가?" },
    ports({ row: { ...evidence, content: sameDayText }, text: "일본 후쿠오카로 출발합니다.", quote: sameDayText })),
    "same-day event does not require redundant date in answer");
  assert.equal(await runVerifiedFallback({ ...input, question: "오늘 삼성 퓨처스팀 어디 가?" },
    ports({ row: { ...evidence, content: sameDayText }, text: sameDayText, quote: sameDayText, sameDay: null })), null,
    "missing eventDateMatchesQuestion rejected even when every date is present and matches today");
  // Final production validation, not just runVerifiedFallback, defines a served answer.
  for (const [question, body, accepted] of [
    ["아시안게임 야구 어떻게 됐어?", "한국 대표팀이 금메달을 획득했습니다.", false],
    ["아시안게임 야구 어떻게 됐어?", "한국 야구 대표팀이 금메달을 획득했습니다.", true],
    ["아시안게임 야구 명단 알려줘", "야구 대표팀 명단은 24명입니다.", true],
    ["아시안게임 야구 어떻게 됐어?", "아시안게임 야구 대표팀은 금메달을 획득했습니다.", true],
    ["아시안게임 야구 어떻게 됐어?", "아시안 게임 야구 대표팀은 금메달을 획득했습니다.", true],
    ["아시안게임 야구 명단 알려줘", "아시안게임 야구 대표팀 명단은 24명입니다.", true],
    ["아시안게임 야구 어떻게 됐어?", "아시안게임 축구 대표팀이 금메달을 획득했습니다.", false],
    ["아시안게임 야구 어떻게 됐어?", "아시안게임 야구 대표팀은 영화에 출연했습니다.", false],
    ["아시안게임 야구 어떻게 됐어?", "아시안게임 야구 대표팀은 모바일 게임을 추천합니다.", false],
    ["아시안게임 야구 어떻게 됐어?", "리그 오브 레전드는 인기 게임입니다.", false],
    ["김도영 최근 근황", "KIA 타이거즈 김도영은 복귀를 준비합니다.", true],
    ["아시안게임 야구 어떻게 됐어?", "축구 대표팀이 금메달을 획득했습니다.", false],
    ["아시안게임 야구 어떻게 됐어?", "LG 티켓 가격은 저렴합니다.", false],
  ] as const) {
    const checked = validateLlmResponse(JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: body }), question);
    assert.equal(checked.kind === "answer", accepted, body);
    const result = await answerQuestion("test", question, deps({ agentFallback: async () => ({
      answer: body + "\n\n📄 출처: 네이버 스포츠", source: "news_rag", sourceUrl: evidence.url,
    }) }));
    assert.equal(result.answer.includes(body), accepted, "actual supplement boundary: " + body);
  }
  assert.equal(primaryNewsDateSupported("오늘 삼성 어디 가?", input.now, "후쿠오카로 향합니다.", [departure]), false);
  assert.equal(primaryNewsDateSupported("오늘 삼성 어디 가?", input.now, "10월 1일 출발합니다.", [departure]), true);
  assert.equal(primaryNewsDateSupported("오늘 삼성 어디 가?", input.now, "후쿠오카로 향합니다.", [sameDayText]), true);
  assert.equal(primaryNewsDateSupported("오늘 삼성 어디 가?", input.now, "후쿠오카로 향합니다.", ["후쿠오카를 방문합니다."]), false);
  assert.equal(primaryNewsDateSupported("최근 삼성 소식", input.now, "후쿠오카로 향합니다.", [departure]), true);
  // Reviewer production snapshots: multiple documents, relative-month dates, durations,
  // an unrelated MMA article and date-free reports must not poison publication questions.
  const capturedNow = primaryNewsBodies.capturedAt;
  for (const [question, text, bodies] of [
    ["오늘 삼성 뉴스 뭐 있어?", "삼성 퓨처스팀은 일본 소프트뱅크와 교류전을 치릅니다.", primaryNewsBodies.samsung],
    ["오늘 삼성 뉴스 뭐 있어?", "삼성 퓨처스팀은 10월 1일부터 15일까지 후쿠오카를 방문합니다.", primaryNewsBodies.samsung],
    ["오늘 김도영 소식 알려줘", "KIA 타이거즈 김도영은 금메달을 걸고 돌아왔습니다.", primaryNewsBodies.kdy],
    ["오늘 김도영 복귀 소식 알려줘", "KIA 타이거즈 김도영은 금메달을 걸고 돌아왔습니다.", primaryNewsBodies.kdy],
    ["어제 김도영 기사 알려줘", "KIA 타이거즈 김도영은 금메달을 걸고 돌아왔습니다.", primaryNewsBodies.kdy],
  ] as const) assert.equal(primaryNewsDateSupported(question, capturedNow, text, bodies), true, question);
  for (const question of ["오늘 삼성 퓨처스팀 어디 가?", "어제 삼성 퓨처스팀 어디 가?", "오늘 삼성 어디 가는지 뉴스 알려줘"]) {
    for (const text of ["일본 후쿠오카로 향합니다.", "후쿠오카를 방문하여 교류전을 치릅니다."]) {
      assert.equal(primaryNewsDateSupported(question, capturedNow, text, primaryNewsBodies.samsung), false,
        "publication noun must not bypass explicit event question");
    }
    assert.equal(primaryNewsDateSupported(question, capturedNow,
      "삼성 퓨처스팀은 10월 1일부터 15일까지 후쿠오카를 방문합니다.", primaryNewsBodies.samsung), true,
      "actual event dates suffice; unrelated dates and 14박 15일 are not required");
  }
  assert.equal(primaryNewsDateSupported("오늘 삼성 어디 가?", capturedNow, "후쿠오카로 향합니다.",
    ["삼성은 9월 29일 훈련했습니다. 삼성은 10월 1일 후쿠오카로 출발합니다."]), false,
    "an unrelated same-day training sentence cannot establish trip date");
  assert.equal(primaryNewsDateSupported("오늘 삼성 어디 가?", capturedNow, "후쿠오카로 향합니다.",
    ["삼성은 9월 29일 후쿠오카로 출발합니다. 다른 선수는 10월 1일 귀국합니다."]), true,
    "unrelated other event dates do not block same-day travel");
  const announcedTrip = '삼성은 "10월 1일부터 15일까지 후쿠오카를 방문한다"고 29일 알렸다.';
  assert.equal(primaryNewsDateSupported("어제 삼성 어디 가?", capturedNow,
    "삼성은 10월 1일부터 15일까지 후쿠오카를 방문합니다.", [announcedTrip]), true,
    "announcement day is not a required trip date");
  assert.equal(primaryNewsDateSupported("오늘 삼성 어디 가?", capturedNow,
    "삼성은 후쿠오카를 방문합니다.", [announcedTrip]), false,
    "removing reporting date must retain the off-day event date");
  assert.equal(primaryNewsDateSupported("오늘 삼성 어디 가?", capturedNow,
    "삼성은 후쿠오카를 방문합니다.", ['삼성은 "후쿠오카를 방문한다"고 29일 알렸다.']), false,
    "announcement day alone never establishes same-day travel");
  assert.equal(primaryNewsDateSupported("어제 김도영 뭐 했어?", capturedNow,
    "김도영은 금메달을 걸고 귀국했습니다.", ["김도영은 9월 28일 금메달을 걸고 귀국했습니다."]), true,
    "explicit yesterday return remains supported");
  // Primary news path must reject before durable storage and logging; replay cannot leak it.
  for (const question of ["오늘 삼성 퓨처스팀 어디 가?", "어제 삼성 퓨처스팀 어디 가?"]) {
    let savedNews: LlmResult | null = null;
    let supplements = 0;
    const newsLogs: Array<string | null> = [];
    const newsDeps = deps({ enableNewsRag: true,
      searchNewsRag: async () => primaryNewsBodies.samsung.map(content => ({ content, pageTitle: "삼성 퓨처스팀", canonicalUrl: evidence.url,
        revision: "test", sectionPath: "news", asOf: question.startsWith("어제") ? "2026-09-28T03:00:00Z" : input.now,
        sourceGrade: "tier2", sourceKind: "news_article" })),
      callNewsRagLlm: async () => ({ text: JSON.stringify({ status: "GROUNDED", answer: "후쿠오카를 방문하여 교류전을 치릅니다." }), inputTokens: 1, outputTokens: 1 }),
      agentFallback: async () => { supplements++; return null; },
      log: async entry => { newsLogs.push(entry.answer); },
      getLlmState: async () => ({ started: false, result: savedNews }), acquireLlmStart: async () => true,
      storeLlm: async value => { savedNews = value; },
    });
    const result = await answerQuestion("test", question, newsDeps);
    assert.equal(result.source, "unsure");
    assert.equal(supplements, 1, "date failure enters verified supplement");
    assert.ok(savedNews);
    assert.equal(unpackStoredQaFinal((savedNews as LlmResult).text)?.answer, result.answer);
    assert.ok(newsLogs.every(answer => !answer?.includes("교류전을 치릅니다")));
    assert.equal((await answerQuestion("test", question, newsDeps)).answer, result.answer);
    assert.equal(supplements, 1, "durable replay does not rerun fallback");
  }
  for (const [question, content] of [["오늘 삼성 퓨처스팀 어디 가?", sameDayText], ["최근 삼성 퓨처스팀 소식", departure]]) {
    let newsCalls = 0;
    const result = await answerQuestion("test", question, deps({ enableNewsRag: true,
      searchNewsRag: async () => [{ content, pageTitle: "삼성 퓨처스팀", canonicalUrl: evidence.url,
        revision: "test", sectionPath: "news", asOf: input.now, sourceGrade: "tier2", sourceKind: "news_article" }],
      callNewsRagLlm: async () => { newsCalls++; return { text: JSON.stringify({ status: "GROUNDED", answer: "후쿠오카를 방문하여 교류전을 치릅니다." }), inputTokens: 1, outputTokens: 1 }; },
      agentFallback: async () => { throw new Error("successful primary must not call supplement"); },
    }));
    assert.equal(newsCalls, 1);
    assert.equal(result.source, "news_rag", "same-day and non-relative primary answers preserved");
    assert.ok(result.answer.includes("교류전을 치릅니다"));
  }
  for (const [question, answer, bodies] of [
    ["오늘 삼성 뉴스 뭐 있어?", "삼성 퓨처스팀은 일본 소프트뱅크와 교류전을 치릅니다.", primaryNewsBodies.samsung],
    ["오늘 김도영 소식 알려줘", "KIA 타이거즈 김도영은 금메달을 걸고 돌아왔습니다.", primaryNewsBodies.kdy],
  ] as const) {
    let supplements = 0;
    const result = await answerQuestion("test", question, deps({ enableNewsRag: true,
      searchNewsRag: async () => bodies.map(content => ({ content, pageTitle: question, canonicalUrl: evidence.url,
        revision: "snapshot", sectionPath: "news", asOf: input.now, sourceGrade: "tier2", sourceKind: "news_article" })),
      callNewsRagLlm: async () => ({ text: JSON.stringify({ status: "GROUNDED", answer }), inputTokens: 1, outputTokens: 1 }),
      agentFallback: async () => { supplements++; return null; },
    }));
    assert.equal(result.source, "news_rag", "multi-article publication question retains primary answer");
    assert.ok(result.answer.includes(answer));
    assert.equal(supplements, 0);
  }
  const wiki = await runVerifiedFallback(input, ports({ row: { ...evidence, source: "wiki", url: "https://namu.wiki/w/야구" } }));
  assert.equal(wiki?.source, "rag", "wiki fallback stays in the existing non-news RAG bucket");
  assert.equal(await runVerifiedFallback(input, ports({ verified: false })), null, "unsupported meaning rejected");
  assert.equal(await runVerifiedFallback(input, ports({ temporal: false })), null, "date semantics rejected");
  assert.equal(await runVerifiedFallback(input, ports({ text: "야구 결승은 9월 29일입니다." })), null, "publication date is not event date");
  assert.equal(await runVerifiedFallback(input, ports({ row: { ...evidence, url: "https://sports.naver.com.evil.test/1" } })), null);
  assert.equal(await runVerifiedFallback(input, ports({ row: { ...evidence, asOf: "2027-01-01" } })), null);
  assert.equal(quoteSupportsNumbers("결승은 29일입니다.", "28일 결승 예정입니다."), false);
  // All verifier replies approve: the code itself must reject stale citations.
  for (const [question, asOf, accepted] of [
    ["오늘 야구 소식", "2026-09-28T14:59:59.999Z", false],
    ["오늘 야구 소식", "2026-09-28T15:00:00.000Z", true],
    ["어제 야구 소식", "2026-09-27T14:59:59.999Z", false],
    ["어제 야구 소식", "2026-09-27T15:00:00.000Z", true],
    ["어제 야구 소식", "2026-09-28T14:59:59.999Z", true],
    ["어제 야구 소식", "2026-09-28T15:00:00.000Z", false],
    ["오늘 야구 소식", "2026-09-29T03:00:00.001Z", false],
    ["오늘 야구 소식", "invalid", false],
    ["오늘과 어제 야구 소식 비교", input.now, false],
  ] as const) {
    const result = await runVerifiedFallback({ ...input, question }, ports({ row: { ...evidence, asOf } }));
    assert.equal(result !== null, accepted, `${question} / ${asOf}`);
  }
  assert.equal(citationWithinQuestionDay("오늘 야구 소식", input.now, { ...evidence, source: "wiki" }), false);
  assert.equal(citationWithinQuestionDay("최근 야구 소식", "invalid", evidence), false);
  const other: Evidence = { ...evidence, id: "news:other", url: "https://sports.naver.com/news/2" };
  let multiTurn = 0;
  const multi = await runVerifiedFallback(input, {
    search: async () => [evidence, other],
    decide: async () => ++multiTurn === 1
      ? { action: "search", source: "news", query: input.question, terms: ["아시안게임"] }
      : multiTurn === 2 ? { action: "answer", claims: [{ ...claim, citations: [
        ...claim.citations, { id: other.id, quote: other.content },
      ] }] } : { supported: true, temporalSupported: true, answersCore: true },
  });
  assert.equal(multi, null, "two valid source URLs cannot be presented as one source");
  assert.equal(multiTurn, 2, "multi-source rejection precedes semantic verifier");
  // Exercise the actual settle boundary, with and without durable ownership.
  const protectedCases: Array<{ question: string; source: string; overrides: Partial<QaDeps> }> = [
    { question: "국제대회 인필드 플라이 뜻", source: "cache", overrides: { getCache: async () => "기존 캐시 정답입니다." } },
    { question: "LG 오늘 지면 몇 위야?", source: "scope_guide", overrides: {} },
    { question: "LG 오늘 소식 알려줘", source: "error", overrides: {
      enableNewsRag: true, searchNewsRag: async () => { throw new Error("search outage"); },
      callNewsRagLlm: async () => { throw new Error("must not call news model"); },
    } },
  ];
  for (const test of protectedCases) for (const durable of [false, true]) {
    assert.equal(fallbackEligible(test.question), true, "protected fixture must be fallback eligible");
    let protectedCalls = 0;
    let saved: LlmResult | null = null;
    const baseline = await answerQuestion("test", test.question, deps(test.overrides));
    assert.equal(baseline.source, test.source, "fixture must reach intended route");
    const result = await answerQuestion("test", test.question, deps({ ...test.overrides,
      agentFallback: async () => { protectedCalls++; return positive; },
      ...(durable ? { getLlmState: async () => ({ started: false, result: null }),
        acquireLlmStart: async () => true, storeLlm: async (value: LlmResult) => { saved = value; } } : {}),
    }));
    assert.equal(protectedCalls, 0, `${test.source} must never invoke fallback (durable=${durable})`);
    assert.deepEqual(result, baseline, `${test.source} answer and route preserved`);
    if (durable) {
      assert.ok(saved, "protected final must cross durable storage");
      assert.equal(unpackStoredQaFinal((saved as LlmResult).text)?.answer, baseline.answer);
    }
  }
  let calls = 0;
  const fallback: NonNullable<QaDeps["agentFallback"]> = async () => { calls++; return positive; };
  const success = await answerQuestion("test", input.question, deps({ agentFallback: fallback,
    callLlm: async () => ({ text: JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: evidence.content }), inputTokens: 1, outputTokens: 1 }) }));
  assert.equal(success.source, "llm"); assert.equal(calls, 0, "existing answer untouched");
  let stored: LlmResult | null = null;
  const logRows: Record<string, unknown>[] = [];
  const owned = deps({ log: async entry => { logRows.push(buildQuestionLogRow(entry, 123)); }, agentFallback: fallback, getLlmState: async () => ({ started: false, result: stored }),
    acquireLlmStart: async () => true, storeLlm: async value => { stored = value; } });
  const filled = await answerQuestion("test", input.question, owned);
  assert.equal(filled.source, "news_rag"); assert.equal(calls, 1);
  assert.equal(unpackStoredQaFinal(stored!.text)?.answer, filled.answer, "durable stores served answer");
  assert.equal((logRows.at(-1)?.classifier_observation as Record<string, unknown>)?.agentFallbackOutcome, "used", "actual log row records accepted supplement");
  const replay = await answerQuestion("test", input.question, owned);
  assert.equal(replay.answer, filled.answer); assert.equal(calls, 1, "no repeat on replay");
  const loser = await answerQuestion("test", input.question, deps({ agentFallback: fallback,
    getLlmState: async () => ({ started: true, result: null, ownerActive: true }), acquireLlmStart: async () => false }));
  assert.equal(loser.source, "pending"); assert.equal(calls, 1, "loser does not search");
  const baseline = await answerQuestion("test", input.question, deps());
  let unsureLog: unknown = "not logged";
  await answerQuestion("test", input.question, deps({ log: async value => { unsureLog = value.answer; } }));
  assert.equal(unsureLog, null, "unfilled generic unsure preserves null-answer analytics contract");
  const failure = await answerQuestion("test", input.question, deps({ agentFallback: async () => { throw new Error("outage"); } }));
  assert.deepEqual(failure, baseline, "failure preserves original response");
  const blocked = await answerQuestion("test", "오늘 비밀번호 알려줘", deps({ agentFallback: fallback,
    callLlm: async () => ({ text: JSON.stringify({ status: "NOT_BASEBALL" }), inputTokens: 1, outputTokens: 1 }) }));
  assert.equal((stored?.classifierObservation as Record<string, unknown>)?.agentFallbackOutcome, "used", "durable observation preserves supplement marker");
  assert.equal(blocked.source, "blocked"); assert.equal(calls, 1);
  assert.equal(await runVerifiedFallback(input, ports(), 1), null, "expired budget skips calls");
  console.log("agent fallback: evidence, date, URL, primary preservation, durable replay, loser, failure boundaries PASS");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
