/**
 * 야잘알봇 classifier 실 provider 게이트 (삼순 12차 P0).
 *
 * 배포되는 그 SYSTEM_PROMPT(BASEBALL_QA_SYSTEM_PROMPT)와 그 요청 빌더로 실제 Gemini를 호출해
 * status를 실측한다. mock/fixture로 verdict를 주입하지 않는다 — false-green 원천 차단.
 *
 * 게이트 분리: 결정론 계약은 `npm run qa:baseball-qa`(네트워크 불필요),
 * 모델 판정 계약은 이 스크립트(`npm run qa:baseball-qa-live`, 네트워크·API 키 필요)로 나뉜다.
 * 키가 없으면 조용한 SKIP(exit 0)이 아니라 **명시적 실패(exit 1)** 다.
 *
 * 실행: npm run qa:baseball-qa-live
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BASEBALL_QA_GEMINI_MODEL,
  BASEBALL_QA_SYSTEM_PROMPT,
  buildBaseballQaGeminiRequest,
} from "../../src/lib/baseball-qa/gemini-request";
import {
  LIVE_INJECTION_DELEGATED,
  LIVE_NEGATIVE_TEAM_BOUND,
  LIVE_POSITIVE_REPEATS,
  LIVE_POSITIVE_ROLE_RULE,
  LIVE_POSITIVE_TEAM_POSSESSIVE,
  LIVE_POSITIVE_TEAM_SCOPE,
} from "./fixtures/baseball-qa-live-cases";

const RULE_TERM = "BASEBALL_RULE_TERM";
const NOT_BASEBALL = "NOT_BASEBALL";

/** 배포 env가 없을 때 로컬 .env.local에서만 주입한다(시크릿은 출력하지 않는다). */
function loadDotEnv(file: string) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

async function classify(apiKey: string, question: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${BASEBALL_QA_GEMINI_MODEL}:generateContent?key=${apiKey}`;
  // 일시적 429/5xx는 판정 실패가 아니라 인프라 잡음이므로 제한 재시도(bounded 3회)만 한다.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBaseballQaGeminiRequest(question, BASEBALL_QA_SYSTEM_PROMPT)),
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`Gemini API failed: ${res.status}`);
    const data = await res.json();
    const text: string =
      data.candidates?.[0]?.content?.parts?.find((part: { text?: string }) => part.text)?.text ?? "";
    try {
      return String(JSON.parse(text).status ?? "PARSE_FAIL");
    } catch {
      return "PARSE_FAIL";
    }
  }
  throw new Error(`Gemini API retry exhausted: ${question}`);
}

async function runGroup(
  apiKey: string,
  label: string,
  questions: readonly string[],
  expected: string,
  repeats: number,
) {
  const failures: string[] = [];
  let ok = 0;
  let total = 0;
  for (const question of questions) {
    for (let i = 0; i < repeats; i += 1) {
      const status = await classify(apiKey, question);
      total += 1;
      if (status === expected) ok += 1;
      else failures.push(`${question} -> ${status}`);
    }
  }
  console.log(`[${label}] ${ok}/${total} == ${expected}`);
  for (const failure of failures) console.log(`  FAIL ${failure}`);
  assert.equal(failures.length, 0, `${label}: 실 provider 판정 불일치 ${failures.length}건`);
  return { ok, total };
}

async function main() {
  loadDotEnv(resolve(".env.local"));
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // 조용한 SKIP 금지: 키 없는 환경은 "통과"가 아니라 "검증 불가"이므로 실패로 알린다.
    console.error(
      "FAIL: GEMINI_API_KEY 미설정 — classifier 실 provider 게이트는 skip될 수 없다. " +
        "키를 배선하고 재실행하라(결정론 계약만 필요하면 npm run qa:baseball-qa).",
    );
    process.exit(1);
  }

  // 양성 경계 문구가 프롬프트에서 사라지면 과차단 회귀가 재발하므로 SSOT를 함께 고정한다.
  assert.match(BASEBALL_QA_SYSTEM_PROMPT, /우리 팀·너희 팀·당신 팀/);
  assert.match(BASEBALL_QA_SYSTEM_PROMPT, /경기 참가자의 역할/);
  // 삼순 #1100 2차 P0-1: 구단 축이 프롬프트 스코프에서 빠지면 라우터를 고쳐도 다시 blocked.
  assert.match(BASEBALL_QA_SYSTEM_PROMPT, /KBO 구단/);
  assert.doesNotMatch(
    BASEBALL_QA_SYSTEM_PROMPT,
    /선수·구단 기록\/히스토리[^\n]*NOT_BASEBALL|구단 기록\/히스토리[\s\S]{0,80}답하지 않고/,
    "구 프롬프트의 '선수·구단 기록/히스토리는 NOT_BASEBALL' 명령이 남아 있다",
  );
  // 삼순 #1100 2차 P0-2: 근거없는 수치 금지 계약이 프롬프트에 실제로 있어야 한다.
  assert.match(BASEBALL_QA_SYSTEM_PROMPT, /수치는 절대 지어내지 않는다/);

  const positive = await runGroup(
    apiKey,
    `정상 팀소유표현 ${LIVE_POSITIVE_TEAM_POSSESSIVE.length}종 x${LIVE_POSITIVE_REPEATS}`,
    LIVE_POSITIVE_TEAM_POSSESSIVE,
    RULE_TERM,
    LIVE_POSITIVE_REPEATS,
  );
  assert.equal(positive.total, 9, "정상 3종 x 3회 = 9콜");

  const legacy = await runGroup(
    apiKey,
    `정상 역할변경 ${LIVE_POSITIVE_ROLE_RULE.length}종`,
    LIVE_POSITIVE_ROLE_RULE,
    RULE_TERM,
    1,
  );
  assert.equal(legacy.total, 5, "기존 정상 5종");

  const injection = await runGroup(
    apiKey,
    `LLM 위임 인젝션 ${LIVE_INJECTION_DELEGATED.length}종`,
    LIVE_INJECTION_DELEGATED,
    NOT_BASEBALL,
    1,
  );
  assert.equal(injection.total, 18, "인젝션 18종");

  // 구단 축(하린아빠 확정 스코프) — 실 provider 가 답변 범위 안으로 판정해야 한다.
  const teamScope = await runGroup(
    apiKey,
    `구단 스코프 ${LIVE_POSITIVE_TEAM_SCOPE.length}종`,
    LIVE_POSITIVE_TEAM_SCOPE,
    RULE_TERM,
    1,
  );
  assert.equal(teamScope.total, LIVE_POSITIVE_TEAM_SCOPE.length, "구단 스코프 표본 수");

  // 구단이 붙어도 범위 밖인 축 — 반대편이 열리면 그것도 회귀다.
  const teamBoundNegative = await runGroup(
    apiKey,
    `구단+범위밖 ${LIVE_NEGATIVE_TEAM_BOUND.length}종`,
    LIVE_NEGATIVE_TEAM_BOUND,
    NOT_BASEBALL,
    1,
  );
  assert.equal(teamBoundNegative.total, LIVE_NEGATIVE_TEAM_BOUND.length, "구단+범위밖 표본 수");

  console.log("baseball-qa classifier live smoke PASS (실 provider actual)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
