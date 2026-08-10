/**
 * 리그 통산·역대 순위 질문 + tier2 답변 성의 회귀 (2026-08-10 하린아빠 캡처 2건).
 *
 * 배경:
 *  - `통산 안타 기록 1위는 누구야?` → "그 기록은 아직 준비되지 않았어요" 차단.
 *    KBO 공식 웹에는 통산 누적 리더보드 구조화 테이블이 없다(기록실 전수 실측)
 *    → 정본 조회 대신 generic LLM 위임, **이름/순위까지만** (수치는 기계 가드).
 *  - `맛자욱 별명이 생긴 이유` → 한 문장 단답. tier2 상한 160자가 설명을 잘랐다
 *    → 320자로 상향 + "이유·배경은 두세 문장으로 충분히" 프롬프트.
 *
 * 고정하는 계약:
 *  1. 리더보드 질문(시점어+정체성 의문, 선수·구단 미지명)은 llm_scope_gate 위임.
 *  2. 선수 지명 통산(`최형우 통산 타율`)·구단 수치는 종전 라우트 그대로 (무회귀).
 *  3. LLM 답변에 질문 밖 숫자가 있으면 기계 가드가 보류(unsure)로 닫는다 —
 *     프롬프트 지시가 아니라 numericTokensSubsetOf 대조가 보장한다.
 *  4. 이름-only 답변은 llm 으로 종결된다 (과차단 방지 양방향).
 *  5. tier2 답변 상한 320자 = tier1 과 동일, 초과 거부 유지.
 */
import assert from "node:assert/strict";
import {
  answerQuestion,
  routeQuestion,
  isCareerLeaderboardAsk,
  UNCLEAR_ANSWER,
  type QaDeps,
  type PlayerRef,
} from "../../src/lib/baseball-qa/pipeline";
import { BASEBALL_QA_SYSTEM_PROMPT } from "../../src/lib/baseball-qa/gemini-request";
import {
  RAG_ANSWER_MAX_CHARS,
  RAG_OFFICIAL_ANSWER_MAX_CHARS,
  RAG_SYSTEM_PROMPT,
} from "../../src/lib/baseball-qa/rag/retrieve";

let pass = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name} :: ${(e as Error).message}`); }
}
const asyncChecks: { name: string; fn: () => Promise<void> }[] = [];
function checkAsync(name: string, fn: () => Promise<void>) { asyncChecks.push({ name, fn }); }

const PLAYERS = [
  { kboId: "72443", name: "최형우", team: "삼성", position: "외야수" },
] as unknown as PlayerRef[];

// ── 1. 판정·라우팅 ────────────────────────────────────────────────────────────
check("리더보드 질문 판정 (캡처 exact 포함)", () => {
  for (const q of [
    "통산 안타 기록 1위는 누구야?",
    "역대 홈런 1위 누구야?",
    "통산 최다 안타는 누가 갖고 있어?",
    "역대 최고 타율은 누구야?",
  ]) {
    assert.equal(isCareerLeaderboardAsk(q), true, q);
    assert.equal(routeQuestion(q, [], PLAYERS), "llm_scope_gate", q);
  }
});
check("무회귀: 선수 지명·수치 없는 질문은 리더보드가 아니다", () => {
  // 선수 지명 통산은 종전 라우트(선수 기록 경로/hold) 그대로 — 위임 대상 아님.
  assert.equal(routeQuestion("최형우 통산 타율 알려줘", [], PLAYERS), "history_hold");
  // 시점어 없는 순위 질문(현재 순위)은 기존 경로.
  assert.equal(isCareerLeaderboardAsk("지금 홈런 1위 누구야?"), false);
  // 정체성 의문 없는 통산 서술.
  assert.equal(isCareerLeaderboardAsk("통산 기록이 뭐야?"), false);
});

// ── 2. 프롬프트·상한 계약 ─────────────────────────────────────────────────────
check("generic 프롬프트 — 리더보드는 이름/순위만, 수치 금지 선언", () => {
  assert.ok(BASEBALL_QA_SYSTEM_PROMPT.includes("통산·역대 순위 질문"));
  assert.ok(BASEBALL_QA_SYSTEM_PROMPT.includes("누적 기록 수치는 쓰지 않는다"));
});
check("tier2 상한 320 = tier1, 성의 지시 선언", () => {
  assert.equal(RAG_ANSWER_MAX_CHARS, 320);
  assert.equal(RAG_ANSWER_MAX_CHARS, RAG_OFFICIAL_ANSWER_MAX_CHARS);
  assert.ok(RAG_SYSTEM_PROMPT.includes("이유·배경·사연을 묻는 질문은 자료 안의 맥락을 두세 문장으로 충분히 설명한다"));
  assert.ok(RAG_SYSTEM_PROMPT.includes("자료에 없는 내용을 보태 길이를 채우지 않는다"));
});

// ── 3. 파이프라인 — 수치 기계 가드 (양방향) ──────────────────────────────────
function makeDeps(llmText: string): { deps: QaDeps; logs: string[] } {
  const logs: string[] = [];
  let stored: unknown = null;
  let started = false;
  const deps = {
    loadGlossary: async () => [],
    loadPlayers: async () => PLAYERS,
    getCache: async () => null,
    setCache: async () => {},
    callLlm: async () => ({ text: llmText, inputTokens: 1, outputTokens: 1 }),
    reserveDaily: async () => ({ allowed: true, remaining: 9 }),
    log: async (row: { matchPath: string }) => { logs.push(row.matchPath); },
    getLlmState: async () => ({ started, result: stored, ownerActive: false }),
    acquireLlmStart: async () => { started = true; return true; },
    storeLlm: async (r: unknown) => { stored = r; },
  } as unknown as QaDeps;
  return { deps, logs };
}

checkAsync("이름-only 답변은 llm 으로 종결 (과차단 방지)", async () => {
  const { deps } = makeDeps(JSON.stringify({
    status: "BASEBALL_RULE_TERM",
    answer: "KBO 통산 최다 안타 기록은 손아섭 선수가 보유한 것으로 알려져 있어요.",
  }));
  const result = await answerQuestion("u1", "통산 안타 기록 1위는 누구야?", deps);
  assert.equal(result.source, "llm", result.answer);
  assert.ok(result.answer.includes("손아섭"));
});
checkAsync("질문 밖 수치가 섞이면 기계 가드가 보류로 닫는다", async () => {
  const { deps, logs } = makeDeps(JSON.stringify({
    status: "BASEBALL_RULE_TERM",
    answer: "통산 안타 1위는 손아섭 선수로 2504안타를 기록했어요.",
  }));
  const result = await answerQuestion("u1", "통산 안타 기록 1위는 누구야?", deps);
  assert.equal(result.answer, UNCLEAR_ANSWER, "검증 불가 수치가 그대로 나가면 안 된다");
  assert.equal(result.source, "unsure");
  assert.ok(logs.includes("unsure"));
});
checkAsync("질문에 있는 숫자 되받기(1위)는 가드를 통과한다", async () => {
  const { deps } = makeDeps(JSON.stringify({
    status: "BASEBALL_RULE_TERM",
    answer: "통산 안타 1위는 손아섭 선수예요.",
  }));
  const result = await answerQuestion("u1", "통산 안타 기록 1위는 누구야?", deps);
  assert.equal(result.source, "llm", result.answer);
});
checkAsync("가드는 리더보드 질문에만 붙는다 — 일반 scope gate 답변 무회귀", async () => {
  // 리더보드 아님 (시점어 없음) → 숫자 있어도 기존 계약 그대로 llm 종결.
  const { deps } = makeDeps(JSON.stringify({
    status: "BASEBALL_RULE_TERM",
    answer: "야구는 9이닝 동안 진행됩니다.",
  }));
  const result = await answerQuestion("u1", "야구 경기는 얼마나 오래 해?", deps);
  assert.equal(result.source, "llm", result.answer);
});

(async () => {
  for (const item of asyncChecks) {
    try { await item.fn(); pass += 1; console.log(`PASS ${item.name}`); }
    catch (e) { failures.push(item.name); console.log(`FAIL ${item.name} :: ${(e as Error).message}`); }
  }
  console.log(`\nbaseball QA leaderboard: PASS=*** FAIL=${failures.length}`);
  if (failures.length > 0) process.exitCode = 1;
})();
