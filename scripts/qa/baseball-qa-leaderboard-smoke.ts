/**
 * 리그 통산·역대 순위 fail-close + 범위밖 denylist 인물 축 삭제 + 답변 성의(길이) 계약.
 *
 * 배경 (2026-08-10 하린아빠 캡처 + 삼순 NO-GO):
 *  - `통산 안타 기록 1위는 누구야?` 를 generic LLM 에 위임하면 숫자 가드를 피해도
 *    **오래된 이름을 확신해서 내보내는 오답**(손아섭 — 실제 1위는 최형우)을 못 잡는다.
 *    KBO 공식 웹에는 대조할 통산 누적 리더보드 정본도 없다 → **fail-close(hold) 유지**.
 *    기준일 있는 공식 큐레이션/물질화 테이블은 별도 트랙이다.
 *  - `작년 LG우승에 가장 큰 기여를 한 사람은 누구야?` 가 denylist `누구` 축에 걸려
 *    전면 차단 → 인물·평가·역사 축을 denylist 에서 삭제(범위 판정은 LLM 위임).
 *  - `맛자욱 별명` 단답 → tier1·tier2·generic 전 경로 길이 계약: 유형별 목표(단순=짧게,
 *    이유·배경=충분히) + 안전 상한(RAG 320 / generic 320).
 *
 * 고정하는 계약:
 *  1. 리더보드 질문(시점어+정체성 의문+지표, 선수·구단 미지명)은 history_hold fail-close.
 *  2. 인물·평가·역사 의문사는 결정론 차단이 아니라 LLM 범위판정 위임.
 *  3. 진짜 범위밖 어휘(맛집·날씨·추천…)는 여전히 차단.
 *  4. 길이 계약: RAG(선수·구단·뉴스) 320 + 성의 지시, generic 320 + 성의 지시.
 */
import assert from "node:assert/strict";
import {
  answerQuestion,
  routeQuestion,
  isCareerLeaderboardAsk,
  type PlayerRef,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";
import { BASEBALL_GENIUS_MAX_ANSWER_LENGTH } from "../../src/lib/constants/baseball-genius";
import { BASEBALL_QA_SYSTEM_PROMPT } from "../../src/lib/baseball-qa/gemini-request";
import {
  RAG_ANSWER_MAX_CHARS,
  RAG_OFFICIAL_ANSWER_MAX_CHARS,
  RAG_SYSTEM_PROMPT,
  RAG_TEAM_SYSTEM_PROMPT,
  RAG_NEWS_SYSTEM_PROMPT,
} from "../../src/lib/baseball-qa/rag/retrieve";

let pass = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name} :: ${(e as Error).message}`); }
}

const PLAYERS = [
  { kboId: "72443", name: "최형우", team: "삼성", position: "외야수" },
] as unknown as PlayerRef[];

// ── 1. 리더보드 = fail-close (generic LLM 위임 금지, 삼순 2026-08-10 NO-GO) ──
check("리더보드 질문은 hold 로 닫힌다 — stale 이름 오답을 LLM 에 맡기지 않는다", () => {
  for (const q of [
    "통산 안타 기록 1위는 누구야?",
    "역대 홈런 1위 누구야?",
    "통산 최다 안타는 누가 갖고 있어?",
    "역대 최고 타율은 누구야?", // 단일시즌 최고기록 정본 존재 축 — generic 강등 금지
  ]) {
    assert.equal(isCareerLeaderboardAsk(q), true, q);
    assert.equal(routeQuestion(q, [], PLAYERS), "history_hold", q);
  }
});

// ── 2. denylist 인물 축 삭제 (캡처: `작년 LG우승에 가장 큰 기여를 한 사람은 누구야?`) ──
check("야구 인물 질문은 결정론 차단이 아니라 위임이다 (캡처 exact 포함)", () => {
  for (const q of [
    "작년 LG우승에 가장 큰 기여를 한 사람은 누구야?", // `LG우승` 결합 토큰 — 팀 면제도 못 타던 표본
    "작년 한국시리즈 MVP 누구야?",
    "LG트윈스 감독 누구야?",
    "역대 최고의 타자는 누구야?", // 지표 없는 주관 평가 — 리더보드 아님, LLM 범위판정
  ]) {
    assert.equal(routeQuestion(q, [], []), "llm_scope_gate", q);
  }
});
check("진짜 범위밖 어휘는 여전히 차단된다 (denylist 축소 방향 안전핀)", () => {
  for (const q of ["LG 경기장 근처 맛집 추천해줘", "오늘 저녁 메뉴 추천", "날씨 어때?"]) {
    assert.equal(routeQuestion(q, [], []), "blocked", q);
  }
});

check("무회귀: 선수 지명·시점어 없는 질문은 리더보드가 아니다", () => {
  assert.equal(routeQuestion("최형우 통산 타율 알려줘", [], PLAYERS), "history_hold");
  assert.equal(isCareerLeaderboardAsk("지금 홈런 1위 누구야?"), false);
  assert.equal(isCareerLeaderboardAsk("통산 기록이 뭐야?"), false);
});

// ── 3. 길이·성의 계약 — 전 경로 (선수·구단·뉴스 RAG + generic) ─────────────────
check("tier2 상한 320 = tier1, 선수 RAG 성의 지시", () => {
  assert.equal(RAG_ANSWER_MAX_CHARS, 320);
  assert.equal(RAG_ANSWER_MAX_CHARS, RAG_OFFICIAL_ANSWER_MAX_CHARS);
  assert.ok(RAG_SYSTEM_PROMPT.includes("이유·배경·사연을 묻는 질문은 자료 안의 맥락을 두세 문장으로 충분히 설명한다"));
  assert.ok(RAG_SYSTEM_PROMPT.includes("자료에 없는 내용을 보태 길이를 채우지 않는다"));
});
check("구단 RAG 도 같은 성의 계약이다 — 한두 문장 강제 잔존 금지 (삼순 축 ③)", () => {
  assert.ok(RAG_TEAM_SYSTEM_PROMPT.includes("이유·배경·사연을 묻는 질문은 자료 안의 맥락을 두세 문장으로 충분히 설명한다"));
  assert.ok(!RAG_TEAM_SYSTEM_PROMPT.includes("한두 문장으로 다시 서술"));
});
check("뉴스 RAG 성의 계약", () => {
  assert.ok(RAG_NEWS_SYSTEM_PROMPT.includes("두세 문장으로 충분히"));
});
check("generic 상한 320 + 성의 지시 (200자 계약 폐기)", () => {
  assert.equal(BASEBALL_GENIUS_MAX_ANSWER_LENGTH, 320);
  assert.ok(BASEBALL_QA_SYSTEM_PROMPT.includes("320자 이하"));
  assert.ok(!BASEBALL_QA_SYSTEM_PROMPT.includes("200자 이하"));
  assert.ok(BASEBALL_QA_SYSTEM_PROMPT.includes("이유·배경·사연·과정을 묻는 질문은 두세 문장으로 충분히"));
});

// ── 4. 성의 축 — 실제 생성답 E2E (삼순 2026-08-10: 프롬프트 문자열 단정만으로는
// 행동 개선이 검증되지 않는다). RAG 경로에 두세 문장·250자 답을 물려 **그대로**
// 유저에게 나가는지, 320 초과는 여전히 거부되는지 종단으로 고정한다.
const RAG_PLAYERS = [
  { kboId: "55555", name: "맛자욱", team: "LG", position: "내야수" },
] as unknown as PlayerRef[];
const RAG_EVIDENCE = [{
  content: "맛자욱은 먹방 예능에서 보여준 먹성 때문에 팬들이 맛자욱이라는 별명을 붙였다고 알려져 있다. 데뷔 초 방송 출연 이후 응원단이 먼저 부르기 시작했고 본인도 마음에 들어해 정착했다.",
  pageTitle: "맛자욱", canonicalUrl: "https://namu.wiki/w/맛자욱", revision: "1",
  sectionPath: "별명", asOf: "2026-01-01", sourceGrade: "tier2",
}];
function ragDeps(llmAnswer: string): { deps: QaDeps; counters: { llm: number } } {
  const counters = { llm: 0 };
  let stored: unknown = null;
  let started = false;
  const deps = {
    loadGlossary: async () => [],
    loadPlayers: async () => RAG_PLAYERS,
    getCache: async () => null,
    setCache: async () => {},
    enablePlayerRag: true,
    searchRag: async () => RAG_EVIDENCE as never,
    callRagLlm: async () => {
      counters.llm++;
      return { text: JSON.stringify({ status: "GROUNDED", answer: llmAnswer }), inputTokens: 10, outputTokens: 5 };
    },
    callLlm: async () => { throw new Error("선수 RAG 질문에서 generic LLM 금지"); },
    searchOfficialRag: async () => { throw new Error("선수 질문은 공식 RAG 미사용"); },
    callOfficialRagLlm: async () => { throw new Error("선수 질문은 공식 RAG 미사용"); },
    reserveDaily: async () => ({ allowed: true, remaining: 9 }),
    log: async () => {},
    getLlmState: async () => ({ started, result: stored, ownerActive: false }),
    acquireLlmStart: async () => { started = true; return true; },
    storeLlm: async (r: unknown) => { stored = r; },
  } as unknown as QaDeps;
  return { deps, counters };
}
const asyncChecks: { name: string; fn: () => Promise<void> }[] = [];
function checkAsync(name: string, fn: () => Promise<void>) { asyncChecks.push({ name, fn }); }

const FULL_ANSWER =
  "맛자욱이라는 별명은 먹방 예능에서 보여준 남다른 먹성 때문에 팬들이 붙여준 거예요. " +
  "데뷔 초 방송 출연이 화제가 된 뒤 응원단이 먼저 부르기 시작했고, 홈 경기 응원가에도 등장하면서 널리 퍼졌다고 알려져 있어요. " +
  "본인도 그 별명을 마음에 들어해서 인터뷰에서 직접 언급할 만큼 지금까지 정착했다고 해요.";
checkAsync("E2E: 이유·배경 질문의 세 문장 답변이 잘리지 않고 그대로 나간다 (캡처 성의 축)", async () => {
  const { deps, counters } = ragDeps(FULL_ANSWER);
  const result = await answerQuestion("u1", "맛자욱 별명이 생긴 이유가 뭐야?", deps);
  // 본문 세 문장이 한 글자도 잃지 않고 나가고, 출처 표기만 뒤에 붙는다.
  assert.ok(result.answer.startsWith(FULL_ANSWER), `세 문장 전체가 그대로 나가야 한다: ${result.answer}`);
  assert.ok(result.answer.includes("출처"), "출처 표기 유지");
  assert.ok(FULL_ANSWER.length > 160, "종전 상한(160)을 실제로 넘는 표본이어야 상향이 검증된다");
  assert.equal(counters.llm, 1);
});
checkAsync("E2E 반대축: 320 초과 답변은 여전히 거부된다 (상한 상향이 무제한 아님)", async () => {
  const over = "가".repeat(340);
  const { deps } = ragDeps(over);
  const result = await answerQuestion("u1", "맛자욱 별명이 생긴 이유가 뭐야?", deps);
  assert.notEqual(result.answer, over, "320 초과가 그대로 나가면 상한이 죽은 것");
});

(async () => {
  for (const item of asyncChecks) {
    try { await item.fn(); pass += 1; console.log(`PASS ${item.name}`); }
    catch (e) { failures.push(item.name); console.log(`FAIL ${item.name} :: ${(e as Error).message}`); }
  }
  console.log(`\nbaseball QA leaderboard: PASS=*** FAIL=${failures.length}`);
  if (failures.length > 0) process.exitCode = 1;
})();
