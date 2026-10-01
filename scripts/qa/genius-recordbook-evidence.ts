import assert from "node:assert/strict";
import { answerQuestion, type QaDeps, type LlmResult } from "../../src/lib/baseball-qa/pipeline";
import { buildRagLlmRequest, selectRecordbookEvidence, RAG_OFFICIAL_SYSTEM_PROMPT, validateRagResponse, type RagEvidence } from "../../src/lib/baseball-qa/rag/retrieve";

// Synthetic passages test wiring/guards, not real production record accuracy.
const evidence: RagEvidence[] = [{ sourceGrade: "tier1", sourceKind: "kbo_ebook",
  pageTitle: "2026 KBO 레코드북", content: "통산 세이브 순위\n선수명 세이브 안타 연도\n오승환 427 0 2025\n레이예스 0 202 2024",
  canonicalUrl: "https://www.koreabaseball.com/Reference/Ebook/Ebook.aspx", revision: "qa", sectionPath: "기록", asOf: "2026-09-30" }];
const response = (value = "427", scope = "historical", citation = 1, subject = "오승환", label = "세이브") => JSON.stringify({ status: "GROUNDED",
  recordScope: scope, recordPeriod: "all", recordPeriodQuote: "", recordYear: 0, recordYearOffset: 0, recordEvidence: citation, recordSubject: subject, recordFacts: [{ label, value }] });
const validated = (raw: string, rows = evidence) => validateRagResponse(raw, { recordbookRequest: true, numericEvidence: true, evidence: rows });
async function main() {
  assert.equal(validated(response()).kind, "grounded");
  for (const raw of [response("427", "current"), response("427", "unknown"),
    response("427", "historical", 0), response("427", "historical", 2),
    JSON.stringify({ status: "GENERAL", answer: "427개입니다." }),
    JSON.stringify({ status: "GROUNDED", answer: "사십이십칠 세이브입니다.", recordScope: "historical", recordEvidence: 1 })]) {
    assert.equal(validated(raw).kind, "insufficient");
  }
  for (const value of ["999", "사십이십칠", "사십이십칠 세이브", "사백이십칠 세이브", "이천이십사년에 이백이안타 일위"]) {
    assert.equal(validated(response(value)).kind, "insufficient", value);
    // Even source-surface reuse must not serve malformed/Hangul-number output.
    assert.equal(validated(response(value), [{ ...evidence[0], content: evidence[0].content + "\n" + value }]).kind,
      "insufficient", value);
  }
  assert.equal(validated(response("999"), [...evidence, { ...evidence[0], content: "다른 선수 999" }]).kind, "insufficient", "cannot borrow numbers from uncited passage");
  assert.equal(validated(response(), [{ ...evidence[0], sourceGrade: "tier2" }]).kind, "insufficient");
  assert.equal(validated(response(), [{ ...evidence[0], pageTitle: "2026 KBO 연감" }]).kind, "insufficient");
  assert.equal(validated(response("202", "historical", 1, "레이예스", "안타")).kind, "grounded");
  const career = [{ ...evidence[0], content: "통산 세이브 순위\n순위 선수명(팀) 세이브 경기 출장 연도 경기수\n1 오승환(삼) 427 2005 ~ 2013, 2020 ~ 2025 (2014 ~ 2019 해외진출) 738\n2 손승락(롯) 271 2005 ~ 2006, 2010 ~ 2019 601" }];
  const misbound = JSON.stringify({ status: "GROUNDED", recordScope: "historical", recordPeriod: "all", recordPeriodQuote: "", recordYear: 0, recordYearOffset: 0, recordEvidence: 1,
    recordSubject: "오승환", recordFacts: [{ label: "세이브", value: "427" }, { label: "연도", value: "738" }] });
  const partial = validated(misbound, career);
  assert.equal(partial.kind, "grounded");
  if (partial.kind === "grounded") { assert.match(partial.answer, /세이브: 427/); assert.doesNotMatch(partial.answer, /연도: 738/); }
  assert.equal(validated(response("738", "historical", 1, "오승환", "연도"), career).kind, "insufficient");
  assert.equal(validated(response("271"), career).kind, "insufficient", "other player row cannot license a value");
  assert.equal(validated(response("738", "historical", 1, "오승환", "세이브"), career).kind, "insufficient", "same-row wrong column");
  assert.equal(validated(response(), [{ ...career[0], content: career[0].content.replace("세이브 경기", "기록 경기") }]).kind, "insufficient", "unknown columns fail closed");
  const season = [{ ...evidence[0], content: "시즌 최다 안타 순위\n순위 선수명(팀) 안타 연도\n1* 레이예스(롯) 202 2024\n2 *서건창(넥) 201 2014" }];
  assert.equal(validated(response("202", "historical", 1, "레이예스", "안타"), season).kind, "grounded");
  assert.equal(validated(response("2024", "historical", 1, "레이예스", "안타"), season).kind, "insufficient");
  const periodRaw = (recordPeriod: string, recordYear: number, recordYearOffset: number, recordPeriodQuote = recordPeriod === "absolute_year" ? String(recordYear) : recordYearOffset === -2 ? "재작년" : recordYearOffset === -1 ? "작년" : "") => JSON.stringify({
    ...JSON.parse(response("202", "historical", 1, "레이예스", "안타")), recordPeriod, recordPeriodQuote, recordYear, recordYearOffset });
  const periodCheck = (question: string, raw: string, rows = season, time = Date.parse("2026-09-30T10:00:00Z")) =>
    validateRagResponse(raw, { recordbookRequest: true, numericEvidence: true, evidence: rows,
      officialQuestion: question, calendarContract: { referenceTimeMs: time } });
  assert.equal(validated(periodRaw("relative_year", 0, -1), season).kind, "insufficient", "relative period requires request clock");
  assert.equal(periodCheck("작년 최다안타", periodRaw("relative_year", 2024, -1)).kind, "insufficient", "ambiguous absolute and relative basis");
  assert.equal(periodCheck("작년 최다안타", periodRaw("relative_year", 0, -1)).kind, "insufficient", "2026 last year is 2025, not the row's 2024");
  assert.equal(periodCheck("2025 최다안타", periodRaw("absolute_year", 2025, 0)).kind, "insufficient");
  assert.equal(periodCheck("2025 최다안타", periodRaw("all", 0, 0)).kind, "insufficient", "cannot erase explicit period");
  assert.equal(periodCheck("2025 최다안타", periodRaw("absolute_year", 2024, 0)).kind, "insufficient");
  assert.equal(periodCheck("2024 최다안타", periodRaw("absolute_year", 2024, 0)).kind, "grounded");
  assert.equal(periodCheck("재작년 최다안타", periodRaw("relative_year", 0, -2)).kind, "grounded");
  assert.equal(periodCheck("작년 최다안타", periodRaw("relative_year", 0, -1), season, Date.parse("2025-09-30T10:00:00Z")).kind, "grounded");
  assert.equal(periodCheck("2024년부터 최다안타", periodRaw("unsupported", 0, 0)).kind, "insufficient");
  assert.equal(periodCheck("작년 최다안타", periodRaw("relative_year", 0, -1), [{ ...season[0], content: season[0].content + "\n다른 표의 연도 2025" }]).kind, "insufficient");
  assert.equal(periodCheck("작년 최다안타", periodRaw("relative_year", 0, -1), [{ ...season[0], content: season[0].content.replace("안타 연도", "안타").replace("202 2024", "202").replace("201 2014", "201") }]).kind, "insufficient");
  for (const question of ["2024년 이후 최다안타", "2024년부터 최다안타", "2024~2025 최다안타", "2024년 이전 최다안타", "최다안타 2024년 이후", "2024년 이 후 최다안타"]) {
    for (const quote of ["2024", "2024년", "2024년 이후"]) {
      assert.equal(periodCheck(question, periodRaw("absolute_year", 2024, 0, quote)).kind, "insufficient", `${question}: cannot drop interval operator`);
    }
    assert.equal(periodCheck(question, periodRaw("all", 0, 0)).kind, "insufficient", "cannot erase interval");
  }
  assert.equal(periodCheck("작년 최다안타", periodRaw("relative_year", 0, -2, "작년")).kind, "insufficient", "server, not model, owns offset");
  assert.equal(periodCheck("지난해 최다안타", periodRaw("absolute_year", 2024, 0, "지난해")).kind, "insufficient");
  assert.equal(periodCheck("작년 최다안타", periodRaw("all", 0, 0)).kind, "insufficient");
  assert.equal(periodCheck("2024 최다안타", periodRaw("absolute_year", 2024, 0, "2025")).kind, "insufficient", "quote must occur verbatim");
  assert.equal(periodCheck("2024년 최다안타", periodRaw("absolute_year", 2024, 0, "2024년")).kind, "grounded");
  assert.equal(periodCheck("지난해 최다안타", periodRaw("relative_year", 0, -1, "지난해"), season, Date.parse("2025-09-30T10:00:00Z")).kind, "grounded");
  const selected = selectRecordbookEvidence([{ ...evidence[0], pageTitle: "2015 KBO 기록대백과" },
    { ...evidence[0], content: "표 설명 ".repeat(170) + "\n오승환 427" }]);
  assert.equal(selected[0].pageTitle, "2026 KBO 레코드북");
  assert.match(selected[0].content, /오승환 427$/);
  const prompt = buildRagLlmRequest("오승환 통산 기록", evidence, RAG_OFFICIAL_SYSTEM_PROMPT, { recordbookRequest: true });
  assert.match(prompt.systemInstruction.parts[0].text, /발행연도에서 1을 빼지/);
  for (const question of ["오승환 통산 기록", "레이예스 최다안타기록"]) {
    let stored: LlmResult | null = null, started = false, calls = 0;
    const deps: QaDeps = {
      loadGlossary: async () => [],
      enablePlayerRag: true,
      fetchCurrentSeasonRecord: async () => [],
      loadPlayers: async () => [{ name: "오승환", kboId: "qa-oh" }, { name: "레이예스", kboId: "qa-reyes" }],
      reserveDaily: async () => ({ allowed: true, remaining: 9 }), log: async () => {},
      getCache: async () => null, setCache: async () => { throw new Error("must not cache historical records"); },
      callLlm: async () => { throw new Error("must not use general knowledge"); },
      searchOfficialRag: async () => evidence,
      callOfficialRagLlm: async (_q, _e, extras) => {
        calls++; assert.equal(extras?.recordbookRequest, true);
        return { text: (question.startsWith("오승환") ? response() : response("202", "historical", 1, "레이예스", "안타")), inputTokens: 5, outputTokens: 4 };
      },
      getLlmState: async () => ({ started, result: stored }),
      acquireLlmStart: async () => { if (started) return false; started = true; return true; },
      storeLlm: async (value) => { stored = value; },
    };
    const result = await answerQuestion("qa-recordbook", question, deps);
    assert.equal(result.source, "rag", question); assert.match(result.answer ?? "", /발행 시점/); assert.equal(calls, 1);
    const replay = await answerQuestion("qa-recordbook", question, deps);
    assert.equal(replay.answer, result.answer); assert.equal(calls, 1);
  }
  let recordOnly = false;
  const filler = await answerQuestion("qa-recordbook-filler", "홈보살 많이 한 선수는?", {
    loadGlossary: async () => [], loadPlayers: async () => [],
    reserveDaily: async () => ({ allowed: true, remaining: 9 }), log: async () => {},
    getCache: async () => null, setCache: async () => {},
    callLlm: async () => { throw new Error("must not fall back to model knowledge"); },
    searchOfficialRag: async () => evidence,
    callOfficialRagLlm: async (_q, _e, extras) => {
      recordOnly = extras?.recordbookRequest === true;
      return { text: JSON.stringify({ status: "GROUNDED", answer: "홈 보살 부문 순위에 오른 선수들이 확인됩니다.", calendarClaims: [] }), inputTokens: 1, outputTokens: 1 };
    },
  });
  assert.equal(recordOnly, true, "ordinary official route with only recordbook evidence uses record contract");
  assert.notEqual(filler.source, "rag", "unsupported filler cannot serve");
  for (const question of ["2:0으로 우천 중단되엇는데 그럼 누가이긴거냐고", "두산베어세"]) {
    const result = await answerQuestion("qa-recordbook-general", question, {
      loadGlossary: async () => [], loadPlayers: async () => [],
      reserveDaily: async () => ({ allowed: true, remaining: 9 }), log: async () => {},
      getCache: async () => null, setCache: async () => {},
      callLlm: async () => { throw new Error("no second generation"); },
      searchOfficialRag: async () => evidence,
      callOfficialRagLlm: async (_q, _e, extras) => {
        assert.equal(extras?.recordbookRequest, true, "strict grounding remains enabled");
        return { text: JSON.stringify({ status: "INSUFFICIENT" }), inputTokens: 1, outputTokens: 1 };
      },
    });
    assert.equal(result.source, "unsure", question);
    assert.doesNotMatch(result.answer ?? "", /그 기록은 아직/);
  }
  console.log("recordbook scope/citation/numeric/durable contracts PASS");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
