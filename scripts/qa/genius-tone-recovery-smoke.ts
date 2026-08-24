/**
 * 야잘알봇 A′ 톤 회수 종단 게이트 (2026-08-24).
 *
 * 검증하는 계약:
 *  ① 어간 불변 닫힌집합만 결정론 정규화하고, 결과를 tone SSOT 로 재검증한다.
 *  ② ①로 못 닫은 일반 용언은 원질문으로 딱 1회 재생성한다.
 *  ③ 재생성 결과도 전수 게이트를 통과해야만 서빙된다. 실패하면 3차 호출 없이 unsure.
 *  ④ 톤 외 결함에는 재호출하지 않는다(비용·공격면 상한).
 *  ⑤ 두 호출 토큰은 합산해 log/store 관측에 남긴다.
 */
import assert from "node:assert/strict";

import {
  answerQuestion,
  UNCLEAR_ANSWER,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";
import {
  isBaseballGeniusToneCompliant,
  normalizeToFormalTone,
} from "../../src/lib/baseball-qa/tone";
import { buildBaseballQaGeminiRequest, TONE_RETRY_PROMPT } from "../../src/lib/baseball-qa/gemini-request";

async function main(): Promise<void> {
let passed = 0;
const ok = (label: string): void => { passed += 1; console.log(`PASS ${label}`); };

// ── ① 닫힌집합 단위 계약 ──────────────────────────────────────────────
const closed: Array<[string, string]> = [
  ["야구에서 보크는 투수의 반칙이에요.", "야구에서 보크는 투수의 반칙입니다."],
  ["야구는 재미있는 스포츠예요!", "야구는 재미있는 스포츠입니다!"],
  ["야구 규칙이 아니에요.", "야구 규칙이 아닙니다."], // 원 사고: 아니입니다 금지
  ["야구에서 득점이 가능해요.", "야구에서 득점이 가능합니다."],
  ["야구 팬은 이 장면을 흥미로워해요.", "야구 팬은 이 장면을 흥미로워합니다."],
  ["야구에서 판정이 뒤집혀요. 결과는 확정돼요.", "야구에서 판정이 뒤집혀요. 결과는 확정됩니다."],
  ["야구에 기록이 있어요. 예외는 없어요.", "야구에 기록이 있습니다. 예외는 없습니다."],
  ["야구에서 이 상황은 규칙이지요.", "야구에서 이 상황은 규칙입니다."],
];
for (const [before, expected] of closed) {
  const result = normalizeToFormalTone(before);
  assert.equal(result.answer, expected, `닫힌 정규화 불일치: ${before}`);
  // 문장 하나라도 열린 활용이 남은 복합문은 compliant=false 여야 한다.
  assert.equal(result.compliant, isBaseballGeniusToneCompliant(expected));
}
ok("닫힌집합 — 계사/부정/하다/되다/있다·없다/지요 정확 변환");

// `아이에요`를 `아입니다`로 쪼개는 류의 체언 경계 오변환을 받침 가드가 막는다.
const invalidBoundary = normalizeToFormalTone("야구 마스코트는 아이에요.");
assert.equal(invalidBoundary.answer, "야구 마스코트는 아이에요.");
assert.equal(invalidBoundary.compliant, false);
assert.doesNotMatch(invalidBoundary.answer, /아입니다/u);
ok("받침 가드 — 체언 경계 오분할 fail-close");

// 열린 활용은 절대 추측 변환하지 않는다.
for (const answer of [
  "야구에서 기록이 만들어져요.",
  "야구 규칙은 상황에 따라 나뉘어요.",
  "야구에서는 그렇게 여기지 않아요.",
]) {
  const result = normalizeToFormalTone(answer);
  assert.equal(result.answer, answer, `열린 활용을 건드리면 안 됨: ${answer}`);
  assert.equal(result.compliant, false);
}
ok("열린집합 — 일반 용언 활용 무변환 + SSOT RED");

// 이미 정상인 답은 byte-identical/no-op.
const formal = "야구에서 보크는 투수의 반칙입니다. 주자는 진루합니다.";
assert.deepEqual(normalizeToFormalTone(formal), { answer: formal, compliant: true, converted: 0 });
ok("정상 합니다체 byte-identical no-op");

// retry prompt는 실제 request 조립 결과에 결속돼야 한다. 상수 존재만 검사하면 배선 누락 false-GREEN.
const retryRequest = buildBaseballQaGeminiRequest("보크가 뭐야?", "BASE", undefined, undefined, false, true);
const retrySystem = retryRequest.systemInstruction.parts[0].text;
assert.ok(retrySystem.startsWith("BASE\n"));
assert.ok(retrySystem.includes(TONE_RETRY_PROMPT));
assert.match(retrySystem, /한 문장도 쓰지 않는다/u);
const normalRequest = buildBaseballQaGeminiRequest("보크가 뭐야?", "BASE");
assert.equal(normalRequest.systemInstruction.parts[0].text, "BASE");
ok("② retry prompt — 실제 provider request seam 결속");

interface RunResult {
  source: string;
  answer: string;
  calls: Array<{ toneRetry: boolean }>;
  logs: Array<Record<string, unknown>>;
  stores: string[];
}

async function runWith(responses: string[]): Promise<RunResult> {
  const calls: Array<{ toneRetry: boolean }> = [];
  const logs: Array<Record<string, unknown>> = [];
  const stores: string[] = [];
  let index = 0;
  const deps: QaDeps = {
    loadGlossary: async () => [],
    loadPlayers: async () => [],
    getCache: async () => null,
    setCache: async () => {},
    reserveDaily: async () => ({ allowed: true, remaining: 19 }),
    callLlm: async (_question, _context, _roster, _stat, toneRetry) => {
      calls.push({ toneRetry: toneRetry === true });
      const text = responses[index++];
      if (text === undefined) throw new Error("unexpected extra LLM call");
      // 호출별 토큰을 다르게 줘 합산을 증명한다.
      return { text, inputTokens: calls.length * 10, outputTokens: calls.length * 3 };
    },
    storeLlm: async (text) => { stores.push(text); },
    log: async (row) => { logs.push(row as unknown as Record<string, unknown>); },
  };
  const result = await answerQuestion("tone-user", "보크가 뭐야?", deps);
  return { source: result.source, answer: result.answer, calls, logs, stores };
}

const json = (answer: string): string => JSON.stringify({ status: "BASEBALL_RULE_TERM", answer });

// ①만으로 닫히면 provider 추가 호출 0.
{
  const r = await runWith([json("야구에서 보크는 투수의 반칙이에요.")]);
  assert.equal(r.source, "llm");
  assert.equal(r.answer, "야구에서 보크는 투수의 반칙입니다.");
  assert.deepEqual(r.calls, [{ toneRetry: false }]);
  assert.equal(r.logs.at(-1)?.inputTokens, 10);
  ok("종단 ① — 닫힌 정규화 회수, 추가 호출 0");
}

// 열린 활용이면 ② 딱 1회, 성공 결과만 서빙 + 토큰 합산.
{
  const r = await runWith([
    json("야구에서 보크는 투수의 반칙으로 여겨요."),
    json("야구에서 보크는 투수의 반칙으로 여깁니다."),
  ]);
  assert.equal(r.source, "llm");
  assert.equal(r.answer, "야구에서 보크는 투수의 반칙으로 여깁니다.");
  assert.deepEqual(r.calls, [{ toneRetry: false }, { toneRetry: true }]);
  assert.equal(r.logs.at(-1)?.inputTokens, 30);  // 10 + 20
  assert.equal(r.logs.at(-1)?.outputTokens, 9); // 3 + 6
  assert.equal(r.stores.length, 1, "최종 envelope store-before-log 1회");
  ok("종단 ② — 열린 활용 1회 재생성 + 전수검증 + 토큰 합산");
}

// retry도 톤 위반이면 3차 호출 없이 unsure.
{
  const r = await runWith([
    json("야구에서 보크는 투수의 반칙으로 여겨요."),
    json("야구에서 보크는 투수의 반칙으로 보여요."),
  ]);
  assert.equal(r.source, "unsure");
  assert.equal(r.answer, UNCLEAR_ANSWER);
  assert.equal(r.calls.length, 2);
  assert.equal(r.logs.at(-1)?.inputTokens, 30);
  ok("종단 fail-close — retry 실패 시 3차 호출 0 + unsure");
}

// retry가 판정을 NOT_BASEBALL로 뒤집어도 원래 tone-unsure 의미를 유지한다.
{
  const r = await runWith([
    json("야구에서 보크는 투수의 반칙으로 여겨요."),
    JSON.stringify({ status: "NOT_BASEBALL", answer: "" }),
  ]);
  assert.equal(r.source, "unsure", "톤 회수가 blocked 로 의미를 바꾸면 안 됨");
  assert.equal(r.answer, UNCLEAR_ANSWER);
  assert.equal(r.calls.length, 2);
  ok("의미 불변 — retry 판정 뒤집힘을 버리고 최초 tone-unsure 유지");
}

// 링크/길이/범위 결함은 톤 retry 대상이 아니다.
{
  const r = await runWith([json("야구 답변은 https://example.com 입니다.")]);
  assert.equal(r.source, "unsure");
  assert.equal(r.calls.length, 1);
  ok("비톤 결함 — 재호출 0");
}

console.log(`ALL PASS (${passed})`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
