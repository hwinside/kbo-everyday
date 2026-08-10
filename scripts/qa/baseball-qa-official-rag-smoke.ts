/**
 * 야잘알봇 KBO 공식 간행물(tier1) 서빙 회귀.
 *
 * 배경: tier2(위키류) 계약은 "숫자를 쓰지 않는다"였다. 그 방어벽이 tier1 1차 출처까지 같이 막고
 * 있어서 규칙·규약 질문을 공식 근거로 답할 수 없었다. 이 스모크는 **막을 것은 계속 막으면서**
 * 공식 근거만 열리는지 고정한다.
 *
 * 고정하는 계약:
 *  1. 등급 분리 — selectEvidence가 tier1/tier2를 섞지 않는다. 섞이면 tier2 서술이 tier1 근거로
 *     둔갑해 숫자를 확정해버린다.
 *  2. tier2 숫자 금지 유지 — 기존 계약이 이 변경으로 느슨해지지 않았다(회귀 방지).
 *  3. tier1 숫자 허용은 **근거에 적힌 숫자만** — 모델이 지어낸 숫자는 tier1이어도 거부한다.
 *  4. 공식 경로는 fail-close 하지 않는다 — 근거 0건이면 null을 돌려 기존 LLM 경로로 내려간다.
 *     (선수 경로의 fail-close를 그대로 적용하면 기존에 답하던 룰 질문이 통째로 막힌다)
 *  5. 미배선이면 기존 동작 불변.
 *  6. 공식 경로가 LLM을 소비했으면 일반 LLM을 다시 호출하지 않는다(호출 1회 계약).
 */

import assert from "node:assert/strict";

import {
  answerQuestion,
  BLOCKED_ANSWER,
  UNCLEAR_ANSWER,
  SYSTEM_ERROR_ANSWER,
  type GlossaryEntry,
  type LlmResult,
  type PlayerRef,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";
import {
  allowsNumericAnswer,
  evidenceGrade,
  numericTokensGrounded,
  RAG_GENERAL_SENTINEL,
  RAG_GROUNDED_SENTINEL,
  RAG_OFFICIAL_ANSWER_MAX_CHARS,
  RAG_OFFICIAL_SYSTEM_PROMPT,
  numericTokensSubsetOf,
  selectEvidence,
  validateRagResponse,
  type RagEvidence,
} from "../../src/lib/baseball-qa/rag/retrieve";
import { gradeForSourceKind } from "../../src/lib/baseball-qa/rag/contracts";

let pass = 0;
const fail: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    fail.push(`${name}: ${(error as Error).message}`);
    console.error(`FAIL ${name}: ${(error as Error).message}`);
  }
}

const OFFICIAL: RagEvidence = {
  content: "5.09 아웃 — 인필드 플라이가 선고된 타구가 베이스에서 떨어져 있는 주자에게 닿았을 때는 타자와 주자가 모두 아웃된다.",
  pageTitle: "2026 공식야구규칙",
  canonicalUrl: "https://www.koreabaseball.com/kbo/board/ebook/ebookpublication.aspx",
  revision: "sha256:8f2c6d595f48b",
  sectionPath: "5.09 아 웃",
  asOf: "2026-08-01",
  sourceGrade: "tier1",
};
const WIKI: RagEvidence = {
  content: "문보경은 LG 트윈스 소속 내야수로 별명은 문학소년이다.",
  pageTitle: "문보경",
  canonicalUrl: "https://ko.wikipedia.org/wiki/문보경",
  revision: "42103021",
  sectionPath: "본문",
  asOf: "2026-08-01",
  sourceGrade: "tier2",
};

// ── 1. 등급 분리 ──────────────────────────────────────────────────────────────
check("등급 분리 — tier1 우선 시 tier2가 섞이지 않는다", () => {
  const selected = selectEvidence([OFFICIAL, WIKI, { ...OFFICIAL, sectionPath: "5.10" }]);
  assert.equal(selected.length, 2, "tier1 2건만 남아야 한다");
  assert.ok(selected.every((row) => row.sourceGrade === "tier1"));
  assert.equal(evidenceGrade(selected), "tier1");
  assert.equal(allowsNumericAnswer(selected), true);
});

check("등급 분리 — tier2가 먼저면 tier1이 섞이지 않는다", () => {
  const selected = selectEvidence([WIKI, OFFICIAL]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].sourceGrade, "tier2");
  assert.equal(allowsNumericAnswer(selected), false, "tier2 묶음은 숫자를 확정할 수 없다");
});

check("등급 분리 — 방어적 혼합 판정은 보수적인 tier2로 떨어진다", () => {
  // selectEvidence를 우회해 직접 섞인 배열이 들어와도 숫자를 열어주면 안 된다.
  assert.equal(evidenceGrade([OFFICIAL, WIKI]), "tier2");
  assert.equal(allowsNumericAnswer([OFFICIAL, WIKI]), false);
});

// ── 2. tier2 숫자 금지 유지 (회귀 방지) ────────────────────────────────────────
check("tier2 숫자 금지 — 기존 계약이 느슨해지지 않았다", () => {
  const numeric = JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "2024년에 20홈런을 쳤어요." });
  assert.equal(validateRagResponse(numeric).kind, "insufficient");
  assert.equal(
    (validateRagResponse(numeric) as { reason: string }).reason,
    "numeric_claim_ungrounded",
  );
  // 옵션을 명시적으로 꺼도 동일
  assert.equal(validateRagResponse(numeric, { numericEvidence: false }).kind, "insufficient");
});

// ── 3. tier1 숫자는 "근거에 적힌 것만" ────────────────────────────────────────
check("tier1 숫자 허용 — 근거에 있는 조문 번호는 통과", () => {
  const raw = JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "공식야구규칙 5.09에 따르면 인필드 플라이 상황에서 타구가 주자에게 닿으면 둘 다 아웃입니다." });
  const result = validateRagResponse(raw, { numericEvidence: true, evidence: [OFFICIAL] });
  assert.equal(result.kind, "grounded", "근거에 5.09가 있으므로 통과해야 한다");
});

check("tier1 숫자 차단 — 근거에 없는 숫자는 모델 창작이므로 거부", () => {
  const raw = JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "공식야구규칙 7.13에 따르면 그렇습니다." });
  const result = validateRagResponse(raw, { numericEvidence: true, evidence: [OFFICIAL] });
  assert.equal(result.kind, "insufficient");
  assert.equal((result as { reason: string }).reason, "numeric_not_in_evidence");
});

check("숫자 토큰 대조 — 부분일치로 통과시키지 않는다", () => {
  const ev = [{ ...OFFICIAL, content: "제1조 목적. 이 규정은 1982년 창립을 기준으로 한다." }];
  // "198"은 "1982"의 부분문자열이지만 독립 토큰으로는 근거에 없다.
  assert.equal(numericTokensGrounded("198년입니다", ev), false);
  assert.equal(numericTokensGrounded("1982년입니다", ev), true);
  // 한 글자 숫자도 마찬가지 — 근거에 1이 있다고 아무 숫자나 통과하면 안 된다
  assert.equal(numericTokensGrounded("7명입니다", ev), false);
});

check("숫자 토큰 대조 — 쉼표 표기 차이는 같은 값으로 본다", () => {
  const ev = [{ ...OFFICIAL, content: "관중은 1,000명이었다." }];
  assert.equal(numericTokensGrounded("1000명입니다", ev), true);
  assert.equal(numericTokensGrounded("1,000명입니다", ev), true);
});

check("숫자 없는 답은 근거 대조를 요구하지 않는다", () => {
  assert.equal(numericTokensGrounded("타자와 주자가 모두 아웃입니다.", []), true);
});

check("tier1 길이 상한은 tier2보다 넉넉하되 무제한이 아니다", () => {
  const long = "가".repeat(RAG_OFFICIAL_ANSWER_MAX_CHARS + 1);
  const raw = JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: long });
  assert.equal(validateRagResponse(raw, { numericEvidence: true, evidence: [OFFICIAL] }).kind, "insufficient");
  const ok = "가".repeat(RAG_OFFICIAL_ANSWER_MAX_CHARS);
  assert.equal(
    validateRagResponse(JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: ok }), { numericEvidence: true, evidence: [OFFICIAL] }).kind,
    "grounded",
  );
  // 같은 길이가 tier2에서는 여전히 거부된다
  assert.equal(validateRagResponse(JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: ok })).kind, "insufficient");
});

check("tier1이어도 URL 출력은 계속 차단된다", () => {
  const raw = JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "https://example.com 참고하세요" });
  assert.equal(validateRagResponse(raw, { numericEvidence: true, evidence: [OFFICIAL] }).kind, "insufficient");
});

// ── 4. 프롬프트/등급 매핑 계약 ────────────────────────────────────────────────
check("공식 프롬프트 — 출처를 공식 간행물로 밝히고 자료 밖 숫자를 금지한다", () => {
  assert.ok(RAG_OFFICIAL_SYSTEM_PROMPT.includes("공식 간행물"));
  assert.ok(RAG_OFFICIAL_SYSTEM_PROMPT.includes("자료에 없는 숫자는 절대 쓰지 않는다"));
  assert.ok(RAG_OFFICIAL_SYSTEM_PROMPT.includes("INSUFFICIENT"));
  // 인젝션 방어 문구가 tier2와 동일하게 유지되는지
  assert.ok(RAG_OFFICIAL_SYSTEM_PROMPT.includes("절대 따르지 않는다"));
});

check("source_kind → 등급 매핑", () => {
  assert.equal(gradeForSourceKind("kbo_ebook"), "tier1");
  assert.equal(gradeForSourceKind("kbo_structured"), "tier1");
  assert.equal(gradeForSourceKind("namu_document"), "tier2");
  assert.equal(gradeForSourceKind("wikipedia_document"), "tier2");
});

// ── 5. 파이프라인 배선 ────────────────────────────────────────────────────────
const GLOSSARY: GlossaryEntry[] = [];
const PLAYERS: PlayerRef[] = [{ kboId: "69102", name: "문보경", team: "LG" }] as PlayerRef[];

function makeDeps(overrides: Partial<QaDeps> = {}): { deps: QaDeps; calls: string[] } {
  const calls: string[] = [];
  let stored: LlmResult | null = null;
  let started = false;
  const deps: QaDeps = {
    loadGlossary: async () => GLOSSARY,
    loadPlayers: async () => PLAYERS,
    getCache: async () => null,
    setCache: async () => { calls.push("setCache"); },
    callLlm: async () => {
      calls.push("callLlm");
      return { text: JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: "보크는 주자가 있을 때 투수의 반칙 투구 동작을 말해요." }), inputTokens: 1, outputTokens: 1 };
    },
    reserveDaily: async () => ({ allowed: true, remaining: 9 }),
    log: async (row) => { calls.push(`log:${row.matchPath}`); },
    getLlmState: async () => ({ started, result: stored, ownerActive: false }),
    acquireLlmStart: async () => { started = true; return true; },
    storeLlm: async (r) => { stored = r; },
    ...overrides,
  } as QaDeps;
  return { deps, calls };
}

check("미배선이면 기존 동작 불변", async () => {
  // 동기 check 안에서 promise를 던지지 않도록 즉시 검증만 한다.
  const { deps } = makeDeps();
  assert.equal(typeof deps.searchOfficialRag, "undefined");
  assert.equal(typeof deps.callOfficialRagLlm, "undefined");
});

const asyncChecks: { name: string; fn: () => Promise<void> }[] = [];
function checkAsync(name: string, fn: () => Promise<void>) { asyncChecks.push({ name, fn }); }

checkAsync("공식 근거 0건 — fail-close 하지 않고 일반 LLM으로 내려간다", async () => {
  const { deps, calls } = makeDeps({
    searchOfficialRag: async () => [],
    callOfficialRagLlm: async () => { throw new Error("근거 0건인데 LLM을 부르면 안 된다"); },
  });
  const result = await answerQuestion("u1", "보크가 뭐야?", deps);
  assert.equal(result.source, "llm", `기존 경로로 내려가야 한다 (실제: ${result.source})`);
  assert.ok(calls.includes("callLlm"), "일반 LLM이 호출되어야 한다");
});

checkAsync("공식 근거 있으면 rag로 답하고 출처가 붙는다", async () => {
  const { deps, calls } = makeDeps({
    searchOfficialRag: async () => [OFFICIAL],
    callOfficialRagLlm: async () => ({
      text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "5.09에 따라 타자와 주자가 모두 아웃입니다." }),
      inputTokens: 10, outputTokens: 5,
    }),
  });
  const result = await answerQuestion("u1", "인필드 플라이 규칙 알려줘", deps);
  assert.equal(result.source, "rag");
  // 출처는 **표시명만** 본문에 남는다 (하린아빠 2026-08-05 P0). tier1 은 `KBO 공식 자료`.
  assert.ok(result.answer.includes("📄 출처: KBO 공식 자료"), "출처 표기가 붙어야 한다");
  // 유저에게 나가면 안 되는 내부 메타 — 하나라도 새면 RED.
  assert.doesNotMatch(result.answer, /crawled/i, "수집 사실을 화면에 적으면 안 된다");
  assert.doesNotMatch(result.answer, /sha256:|rev\s/, "revision 은 내부 provenance 다");
  assert.doesNotMatch(result.answer, /https?:\/\//, "전체 URL 은 본문에 노출하지 않는다");
  assert.doesNotMatch(result.answer, /2026-08-01 기준/, "asOf 날짜는 유저가 볼 이유가 없다");
  // 링크는 payload 로 간다 — 클라가 표시명에 앵커를 씌운다.
  assert.equal(result.sourceUrl, OFFICIAL.canonicalUrl, "근거 링크는 payload 로 전달해야 한다");
  assert.ok(result.answer.includes("5.09"), "근거에 있는 숫자는 남아야 한다");
  assert.ok(!calls.includes("callLlm"), "공식 경로가 답했으면 일반 LLM을 다시 부르지 않는다");
});

checkAsync("공식 근거로도 답을 못 만들면 unsure로 종결한다(일반 LLM 재호출 금지)", async () => {
  const { deps, calls } = makeDeps({
    searchOfficialRag: async () => [OFFICIAL],
    callOfficialRagLlm: async () => ({
      text: JSON.stringify({ status: "INSUFFICIENT" }), inputTokens: 10, outputTokens: 1,
    }),
  });
  const result = await answerQuestion("u1", "인필드 플라이 규칙 알려줘", deps);
  assert.equal(result.source, "unsure");
  // 공식 근거로 답을 못 만든 것뿐이다 — 룰 질문에 "야구 질문만 하라"고 답하면 안 된다.
  assert.equal(result.answer, UNCLEAR_ANSWER);
  assert.notEqual(result.answer, BLOCKED_ANSWER, "근거 부족에 범위밖 문구 금지");
  assert.ok(!calls.includes("callLlm"), "LLM 호출 1회 계약 — 재호출 금지");
});

checkAsync("공식 RAG timeout은 exact fallback으로 수렴한다", async () => {
  const { deps, calls } = makeDeps({
    searchOfficialRag: async () => [OFFICIAL],
    callOfficialRagLlm: async () => { throw new Error("timeout"); },
  });
  const result = await answerQuestion("u1", "인필드 플라이 규칙 알려줘", deps);
  assert.equal(result.source, "error");
  // 룰 질문에 시스템 오류가 났을 뿐이다 — "야구 질문만 하라"도, "못 알아들었다"도 아니다.
  // 시스템 오류 전용 문구를 쓴다 (삼순 2026-08-08 ①).
  assert.equal(result.answer, SYSTEM_ERROR_ANSWER);
  assert.notEqual(result.answer, BLOCKED_ANSWER, "시스템 오류에 범위밖 문구 금지");
  assert.notEqual(result.answer, UNCLEAR_ANSWER, "시스템 오류를 이해못함 문구로 말하면 안 된다");
  assert.ok(!calls.includes("callLlm"), "timeout 뒤 일반 LLM 재호출 금지");
});

checkAsync("일반 LLM timeout·무응답도 exact fallback으로 수렴한다", async () => {
  for (const callLlm of [
    async () => { throw new Error("timeout"); },
    async () => ({ text: "", inputTokens: null, outputTokens: null }),
  ]) {
    const { deps } = makeDeps({
      searchOfficialRag: async () => [],
      callOfficialRagLlm: async () => { throw new Error("근거 0건에서 호출 금지"); },
      callLlm,
    });
    const result = await answerQuestion("u1", "잔루만루가 뭔데", deps);
    // provider throw = 우리 고장(`error`) / 빈 응답 = 판정 불명확(`unsure`).
    // 두 실패는 유저에게 다른 사실을 말해야 한다 (삼순 2026-08-08 ①).
    const expected = result.source === "error" ? SYSTEM_ERROR_ANSWER : UNCLEAR_ANSWER;
    assert.equal(result.answer, expected, `source=${result.source} 인데 문구가 다르다`);
    assert.notEqual(result.answer, BLOCKED_ANSWER, "provider 실패에 범위밖 문구 금지");
    assert.ok(["unsure", "error"].includes(result.source));
  }
});

checkAsync("검색이 던져도 기능이 죽지 않는다 (기존 경로로 양보)", async () => {
  const { deps, calls } = makeDeps({
    searchOfficialRag: async () => { throw new Error("db down"); },
    callOfficialRagLlm: async () => { throw new Error("호출되면 안 됨"); },
  });
  const result = await answerQuestion("u1", "보크가 뭐야?", deps);
  assert.equal(result.source, "llm");
  assert.ok(calls.includes("callLlm"));
});

checkAsync("tier2 근거가 공식 경로로 새면 답하지 않는다", async () => {
  const { deps, calls } = makeDeps({
    searchOfficialRag: async () => [WIKI],
    callOfficialRagLlm: async () => { throw new Error("tier2로 공식 경로를 타면 안 된다"); },
  });
  const result = await answerQuestion("u1", "보크가 뭐야?", deps);
  assert.equal(result.source, "llm", "tier2는 공식 경로에서 거부되고 기존 경로로 내려간다");
  assert.ok(calls.includes("callLlm"));
});

checkAsync("모델이 지어낸 숫자는 tier1이어도 서빙하지 않는다", async () => {
  const { deps } = makeDeps({
    searchOfficialRag: async () => [OFFICIAL],
    callOfficialRagLlm: async () => ({
      text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "규칙 7.13에 따라 3명이 아웃됩니다." }),
      inputTokens: 10, outputTokens: 5,
    }),
  });
  const result = await answerQuestion("u1", "인필드 플라이 규칙 알려줘", deps);
  assert.equal(result.source, "unsure", "근거에 없는 7.13/3은 거부되어야 한다");
});

checkAsync("검수 사전이 있으면 공식 경로보다 우선한다(토큰 0 우선)", async () => {
  const { deps, calls } = makeDeps({
    loadGlossary: async () => ([{ term: "보크", aliases: [], answer: "보크는 투수의 반칙 행위예요." } as GlossaryEntry]),
    searchOfficialRag: async () => { throw new Error("사전이 먼저 답해야 한다"); },
    callOfficialRagLlm: async () => { throw new Error("호출되면 안 됨"); },
  });
  const result = await answerQuestion("u1", "보크가 뭐야?", deps);
  assert.equal(result.source, "dictionary");
  assert.ok(calls.includes("log:dictionary"));
});

// ⚠️ 예전 이 자리에는 "캐시가 있으면 공식 경로보다 우선한다" 가 있었고 searchOfficialRag 를
// throw 시켰다. 구현은 검색 예외를 catch 한 뒤 캐시로 fallback 하므로 **순서를 어떻게 두든
// 항상 초록**이었다(삼순 R2/R4 지적 — false-green). 이제 계약이 반대이므로,
// stale cache 와 valid tier1 evidence 를 **동시에** 두고 실제 승자를 본다.
checkAsync("오염 캐시가 있어도 공식 tier1 근거가 이긴다", async () => {
  let cacheReads = 0;
  const { deps } = makeDeps({
    getCache: async () => { cacheReads += 1; return "tier1 적재 전에 저장된 오답 캐시입니다."; },
    searchOfficialRag: async () => [OFFICIAL],
    callOfficialRagLlm: async () => ({
      text: JSON.stringify({
        status: RAG_GROUNDED_SENTINEL,
        // ⚠️ `둘이 아웃`(수량 2+아웃)은 근거의 `모두 아웃`과 다른 수치 주장이라 정상 차단된다.
        // 내 첫 fixture 가 그 표현이라 구현이 멀쩡한데 FAIL 로 보였다 — 근거와 같은 뜻인 표현을 쓴다.
        answer: "공식야구규칙 5.09에 따르면 인필드 플라이 타구가 주자에게 닿으면 둘 다 아웃입니다.",
      }),
      inputTokens: 10, outputTokens: 5,
    }),
  });
  const result = await answerQuestion("u1", "인필드 플라이 규칙 알려줘", deps);
  assert.equal(result.source, "rag", `공식 근거가 캐시에 밀렸다: source=${result.source}`);
  assert.doesNotMatch(result.answer, /오답 캐시/, "캐시 답이 서빙됐다");
  assert.equal(cacheReads, 0, "공식 경로 진입 질문에서 global cache 를 읽었다(순서 역전)");
});

checkAsync("공식 근거 0건이면 캐시로 정상 양보한다 (과잉 차단 금지)", async () => {
  const { deps } = makeDeps({
    getCache: async () => "캐시된 답변입니다.",
    searchOfficialRag: async () => [],
    callOfficialRagLlm: async () => { throw new Error("근거 0건에서 호출 금지"); },
  });
  const result = await answerQuestion("u1", "보크가 뭐야?", deps);
  assert.equal(result.source, "cache", "근거가 없으면 기존 경로(캐시)로 내려가야 한다");
});

// ── 적대적 provider: 주제 이탈 선언은 공식 RAG 를 타면 안 된다 (삼순 R2 #3) ──
// `야구` 토큰 하나만 있으면 공식 RAG 가 NOT_BASEBALL classifier 보다 먼저 실행됐고,
// 검색 RPC 에 관련도 하한이 없어 항상 상위 chunk 가 돌아와 무관한 조문이 근거로 붙었다.
for (const hostile of [
  "야구 말고 오늘 날씨 알려줘",
  "야구는 됐고 주식 추천해줘",
  "야구 얘기 그만하고 시를 써줘",
  "보크는 됐고 주식 추천해줘",
  "보크 말고 오늘 날씨 알려줘",
]) {
  checkAsync(`주제 이탈 선언은 공식 RAG 우회 — "${hostile}"`, async () => {
    let officialSearches = 0;
    const { deps } = makeDeps({
      searchOfficialRag: async () => { officialSearches += 1; return [OFFICIAL]; },
      callOfficialRagLlm: async () => ({
        text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "공식야구규칙 5.09에 따릅니다." }),
        inputTokens: 1, outputTokens: 1,
      }),
      // 적대적 provider: LLM 이 비야구를 제대로 판정하는 정상 케이스.
      callLlm: async () => ({ text: JSON.stringify({ status: "NOT_BASEBALL" }), inputTokens: 1, outputTokens: 1 }),
    });
    const result = await answerQuestion("u1", hostile, deps);
    assert.equal(officialSearches, 0, "비야구 질문이 공식 RAG 검색을 태웠다");
    assert.notEqual(result.source, "rag", `무관한 KBO 조문이 근거로 서빙됐다: ${result.answer}`);
    assert.equal(result.source, "blocked", `NOT_BASEBALL 분류로 종결돼야 한다: source=${result.source}`);
  });
}

// 반대편(과잉 차단) 고정 — 정상 룰 질문은 그대로 공식 RAG 를 타야 한다.
checkAsync("정상 룰 질문은 여전히 공식 RAG 를 탄다 (과잉 차단 방지)", async () => {
  let officialSearches = 0;
  const { deps } = makeDeps({
    searchOfficialRag: async () => { officialSearches += 1; return [OFFICIAL]; },
    callOfficialRagLlm: async () => ({
      text: JSON.stringify({
        status: RAG_GROUNDED_SENTINEL,
        answer: "공식야구규칙 5.09에 따르면 인필드 플라이 타구가 주자에게 닿으면 둘 다 아웃입니다.",
      }),
      inputTokens: 1, outputTokens: 1,
    }),
  });
  const result = await answerQuestion("u1", "인필드 플라이 규칙 알려줘", deps);
  assert.equal(officialSearches, 1);
  assert.equal(result.source, "rag");
});


// ── GENERAL 3상 판정 (2026-08-10 unsure 함정 제거) ─────────────────────────────
// 재현: `지명 타자의 DH 약자`·`ph 포지션`·`잔루만루`·`wRC+ 해석` 이 공식 경로에 빨려
// 들어간 뒤 INSUFFICIENT → unsure 하드 종결. GENERAL 은 같은 한 번의 호출에 "일반
// 야구 지식으로 답한다" 출구를 연다. 숫자는 질문 밖 토큰을 기계 폐기한다.

check("GENERAL: generalFallback 옵션이 있으면 일반 지식 답변을 수용한다", () => {
  const v = validateRagResponse(
    JSON.stringify({ status: RAG_GENERAL_SENTINEL, answer: "야구에서 PH는 대타를 뜻하는 용어입니다." }),
    { numericEvidence: true, evidence: [OFFICIAL], generalFallback: { question: "야구 포지션 중에 ph가 뭐야?" } },
  );
  assert.equal(v.kind, "general");
});

check("GENERAL: 옵션이 없으면 종전대로 폐기한다 (경로별 opt-in)", () => {
  const v = validateRagResponse(
    JSON.stringify({ status: RAG_GENERAL_SENTINEL, answer: "야구에서 PH는 대타입니다." }),
    { numericEvidence: true, evidence: [OFFICIAL] },
  );
  assert.equal(v.kind, "insufficient");
});

check("GENERAL 숫자 계약: 질문에 있는 숫자 되받기는 허용", () => {
  const v = validateRagResponse(
    JSON.stringify({ status: RAG_GENERAL_SENTINEL, answer: "야구에서 wRC+ 88은 리그 평균보다 조금 낮은 타격 생산력을 뜻합니다." }),
    { numericEvidence: true, evidence: [OFFICIAL], generalFallback: { question: "wRC+가 88정도인데 가치는?" } },
  );
  assert.equal(v.kind, "general");
});

check("GENERAL 숫자 계약: 질문 밖 숫자는 루 이름(1루·2루·3루)이어도 예외 없이 폐기 — 삼순 NO-GO ① strict subset", () => {
  const v = validateRagResponse(
    JSON.stringify({ status: RAG_GENERAL_SENTINEL, answer: "야구에서 잔루만루는 1루, 2루, 3루에 주자가 있는 채 이닝이 끝난 상황입니다." }),
    { numericEvidence: true, evidence: [OFFICIAL], generalFallback: { question: "잔루만루가 뭐야?" } },
  );
  assert.equal(v.kind, "insufficient", "0~12 예외가 되살아나면 WAR 5·홈런 5개가 같이 뚫린다");
});

check("GENERAL 숫자 계약: 숫자 없는 잔루만루 서술은 통과 (프롬프트가 유도하는 정답형)", () => {
  const v = validateRagResponse(
    JSON.stringify({ status: RAG_GENERAL_SENTINEL, answer: "야구에서 잔루만루는 모든 베이스에 주자가 남은 채 이닝이 종료된 상황을 뜻합니다." }),
    { numericEvidence: true, evidence: [OFFICIAL], generalFallback: { question: "잔루만루가 뭐야?" } },
  );
  assert.equal(v.kind, "general");
});

check("GENERAL 숫자 계약: 음성 3종 — WAR 5 · 홈런 5개 · 5,000개 전부 폐기 (삼순 exact)", () => {
  for (const bad of [
    "그 선수는 WAR이 5 정도로 평가받습니다.",
    "야구에서 그 기록은 홈런 5개를 뜻합니다.",
    "야구에서 통산 안타 5,000개는 대기록입니다.",
  ]) {
    const v = validateRagResponse(
      JSON.stringify({ status: RAG_GENERAL_SENTINEL, answer: bad }),
      { numericEvidence: true, evidence: [OFFICIAL], generalFallback: { question: "잔루만루가 뭐야?" } },
    );
    assert.equal(v.kind, "insufficient", `허용되면 안 되는 답이 통과: ${bad}`);
    assert.equal((v as { reason: string }).reason, "numeric_not_in_question");
  }
});

check("GENERAL 숫자 계약: 질문 밖 연도·기록치는 기계 폐기", () => {
  for (const bad of ["한국 야구는 1982년에 출범했습니다.", "그 선수는 홈런 56개를 쳤습니다.", "타율 0.312 정도면 최상위권입니다."]) {
    const v = validateRagResponse(
      JSON.stringify({ status: RAG_GENERAL_SENTINEL, answer: bad }),
      { numericEvidence: true, evidence: [OFFICIAL], generalFallback: { question: "잔루만루가 뭐야?" } },
    );
    assert.equal(v.kind, "insufficient", `허용되면 안 되는 답이 통과: ${bad}`);
    assert.equal((v as { reason: string }).reason, "numeric_not_in_question");
  }
});

check("numericTokensSubsetOf: strict subset — 예외 없음, 토큰 단위 대조", () => {
  assert.equal(numericTokensSubsetOf("8개의 팀", "88점"), false, "8이 88 안에 있다고 통과하면 안 된다");
  assert.equal(numericTokensSubsetOf("82개나 됩니다", "882점"), false);
  assert.equal(numericTokensSubsetOf("88 정도입니다", "88점"), true);
  assert.equal(numericTokensSubsetOf("9이닝 동안", "이닝이 뭐야"), false, "질문에 없는 숫자는 룰 어휘여도 거부");
  assert.equal(numericTokensSubsetOf("5,000개입니다", "질문"), false, "콤마 분할 토큰도 거부");
  assert.equal(numericTokensSubsetOf("숫자가 없는 답", "아무 질문"), true);
});

check("깨진 \\u escape 는 복구 없이 malformed fail-close — 삼순 NO-GO ② 손상 문자열 발송 금지", () => {
  const broken = '{"status":"GENERAL","answer":"PH\\ub2n4 대타를 뜻합니다"}';
  const v = validateRagResponse(broken, {
    numericEvidence: true, evidence: [OFFICIAL], generalFallback: { question: "ph가 뭐야?" },
  });
  assert.equal(v.kind, "insufficient", "강등 재파싱이 되살아나면 PHub2n4 같은 손상 답이 유저에게 나간다");
  assert.equal((v as { reason: string }).reason, "malformed_json");
});

check("공식 프롬프트가 GENERAL 3상 계약을 선언한다", () => {
  assert.ok(RAG_OFFICIAL_SYSTEM_PROMPT.includes(RAG_GENERAL_SENTINEL));
  assert.ok(RAG_OFFICIAL_SYSTEM_PROMPT.includes("숫자를 쓰지 않는다"));
});

checkAsync("파이프라인: 공식 경로 GENERAL 은 unsure 가 아니라 llm 답변으로 종결한다", async () => {
  const { deps } = makeDeps({
    searchOfficialRag: async () => [OFFICIAL],
    callOfficialRagLlm: async () => ({
      text: JSON.stringify({ status: RAG_GENERAL_SENTINEL, answer: "야구에서 지명타자 DH는 Designated Hitter의 약자입니다." }),
      inputTokens: 1, outputTokens: 1,
    }),
  });
  const result = await answerQuestion("u1", "지명 타자의 DH 는 뭐의 약자야?", deps);
  assert.equal(result.source, "llm", `unsure 함정 회귀: source=${result.source}`);
  assert.notEqual(result.answer, UNCLEAR_ANSWER);
});

checkAsync("파이프라인: malformed 응답은 최종 answer 가 UNCLEAR exact — 손상 문자열 미발송 (삼순 NO-GO ②)", async () => {
  const { deps } = makeDeps({
    searchOfficialRag: async () => [OFFICIAL],
    callOfficialRagLlm: async () => ({
      text: '{"status":"GENERAL","answer":"PH\\ub2n4 대타를 뜻합니다"}',
      inputTokens: 1, outputTokens: 1,
    }),
  });
  const result = await answerQuestion("u1", "야구 포지션 중에 ph가 뭐야?", deps);
  assert.equal(result.answer, UNCLEAR_ANSWER, "kind 만 보지 말고 최종 answer exact 로 고정");
  assert.ok(!result.answer.includes("ub2n4"), "손상 문자열이 발송되면 안 된다");
  assert.equal(result.source, "unsure");
});


checkAsync("파이프라인: 공식 경로 GENERAL 답의 질문 밖 숫자는 여전히 unsure fail-close", async () => {
  const { deps } = makeDeps({
    searchOfficialRag: async () => [OFFICIAL],
    callOfficialRagLlm: async () => ({
      text: JSON.stringify({ status: RAG_GENERAL_SENTINEL, answer: "그 선수는 2019년에 홈런 44개를 쳤습니다." }),
      inputTokens: 1, outputTokens: 1,
    }),
  });
  const result = await answerQuestion("u1", "지명 타자의 DH 는 뭐의 약자야?", deps);
  assert.equal(result.source, "unsure", "지어낸 수치가 GENERAL 로 새면 안 된다");
});

(async () => {
  for (const { name, fn } of asyncChecks) {
    try {
      await fn();
      pass += 1;
      console.log(`PASS ${name}`);
    } catch (error) {
      fail.push(`${name}: ${(error as Error).message}`);
      console.error(`FAIL ${name}: ${(error as Error).message}`);
    }
  }
  console.log(`\nbaseball QA official RAG: PASS=${pass} FAIL=${fail.length}`);
  if (fail.length > 0) {
    for (const f of fail) console.error("  -", f);
    process.exit(1);
  }
})();
