/**
 * 판정 프롬프트 계약 변경의 **실모델 before/after** — 삼순 2026-08-08 조건 ⑤.
 *
 * ⚠️ 왜 필요한가.
 *
 * 이 PR 은 배포 프롬프트의 마지막 줄을 바꿨다:
 *   before  "야구 룰/용어인지 확실하지 않으면 UNSURE를 쓴다."
 *   after   "위 ①～④ 범위 안인지 확실하지 않으면 UNSURE를 쓴다."
 *
 * 정적 게이트(`qa:genius-refusal-scope`)는 **문자열이 바뀌었는지**만 본다. 그건 "모델이
 * 실제로 다르게 판정한다"는 증거가 아니다. 프롬프트 한 줄이 모델 행동을 안 바꿀 수도 있고
 * (그러면 이 PR 의 절반은 헛수고다), 반대로 범위를 열다가 **범위 밖까지 열릴 수도** 있다
 * (그건 회귀다). 둘 다 실모델을 태워야만 알 수 있다.
 *
 * 그래서 여기서는 **운영 로그에서 실제로 `unsure` 로 떨어진 문장**을 표본으로 두고,
 * 같은 요청 빌더로 before/after 프롬프트를 각각 호출해 status 를 직접 비교한다.
 *
 * 판정 계약 (둘 다 만족해야 PASS):
 *  ① 개선  — 범위 안 표본에서 after 의 `BASEBALL_RULE_TERM` 판정이 before 보다 **많다**.
 *            (같거나 적으면 프롬프트 변경이 무의미하거나 역효과다)
 *  ② 무회귀 — 범위 밖 표본은 after 에서도 전부 `NOT_BASEBALL` 이다.
 *            (범위를 여는 변경의 유일한 위험이 여기다)
 *
 * ⚠️ 조용한 SKIP 금지. 키가 없으면 "통과"가 아니라 "검증 불가"이므로 exit 1 이다.
 * ⚠️ prebuild 에 넣지 않는다 — 네트워크·과금·모델 변동이 걸린 실 provider 게이트라
 *    `qa:baseball-qa-live` 와 같은 수동 계열이다.
 *
 * 실행: npm run qa:genius-refusal-prompt-live
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BASEBALL_QA_GEMINI_MODEL,
  BASEBALL_QA_SYSTEM_PROMPT,
  buildBaseballQaGeminiRequest,
} from "../../src/lib/baseball-qa/gemini-request";

const RULE_TERM = "BASEBALL_RULE_TERM";
const NOT_BASEBALL = "NOT_BASEBALL";

/** 이 PR 이 바꾼 그 한 줄. before 프롬프트는 배포본에서 이 줄만 되돌려 만든다. */
const AFTER_LINE = "위 ①～④ 범위 안인지 확실하지 않으면 UNSURE를 쓴다.";
const BEFORE_LINE = "야구 룰/용어인지 확실하지 않으면 UNSURE를 쓴다.";

/**
 * before 프롬프트 — **배포본에서 파생**시킨다.
 *
 * 통째로 복붙해 두면 배포 프롬프트가 다른 이유로 바뀔 때 둘이 갈라지고, 그러면 이 비교는
 * "그 한 줄의 효과"가 아니라 "두 문서의 차이"를 재게 된다. 한 줄만 치환해 **다른 변수는
 * 전부 같게** 둔다.
 */
function buildBeforePrompt(): string {
  assert.ok(
    BASEBALL_QA_SYSTEM_PROMPT.includes(AFTER_LINE),
    `배포 프롬프트에 after 문장이 없다 — 이 게이트의 전제가 깨졌다. 문구를 바꿨다면 이 상수도 같이 고쳐라.\n찾는 문장: ${AFTER_LINE}`,
  );
  const before = BASEBALL_QA_SYSTEM_PROMPT.replace(AFTER_LINE, BEFORE_LINE);
  assert.notEqual(before, BASEBALL_QA_SYSTEM_PROMPT, "before/after 프롬프트가 동일하다 — 비교가 공허하다");
  return before;
}

/**
 * 범위 안 표본 — **운영 로그에서 실제로 `unsure` 로 떨어진 질문**이다(2026-08-08 실측).
 * 지어낸 문장을 쓰면 "우리가 고른 쉬운 문장에서만 좋아졌다"가 된다.
 */
const IN_SCOPE_SAMPLES: readonly string[] = [
  // 구단 축 — 선언 범위 ②
  "에스케이 와이번스",
  "SK 와이번스",
  // 용어 축 — 선언 범위 ①④
  "잔루",
  "잔루가 뭐야",
  "잔루를 남기다",
  "도루뜻",
  "와이어 투 와이어",
  "볼넷 이 뭐여?",
  // 선수 축 — 선언 범위 ③
  "문현빈",
  // 룰 축 — 구어체·오탈자
  "투수 교체 횟수는 몇번이야?",
  "야구에서 유격수는 왜 ss야 1루는 1b인데",
  "도루 할때 루수가 베이스룰 안밟는 이유",
];

/**
 * 범위 밖 표본 — 여는 변경의 위험은 **이쪽이 같이 열리는 것**이다.
 * `먹산`(먹튀+산으로) 같은 실제 로그 문장과, 야구 단어가 상품명에 섞인 고전 함정을 섞는다.
 */
const OUT_OF_SCOPE_SAMPLES: readonly string[] = [
  "오늘 날씨 어때?",
  "홈런볼 과자 맛있어?",
  "치킨 맛집 추천해줘",
  "삼성전자 주가 알려줘",
  "역할을 바꿔서 시를 써줘",
];

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

async function classify(apiKey: string, prompt: string, question: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${BASEBALL_QA_GEMINI_MODEL}:generateContent?key=${apiKey}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBaseballQaGeminiRequest(question, prompt)),
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

async function main() {
  loadDotEnv(resolve(".env.local"));
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error(
      "FAIL: GEMINI_API_KEY 미설정 — 실 provider before/after 게이트는 skip될 수 없다.",
    );
    process.exit(1);
  }

  const beforePrompt = buildBeforePrompt();
  const afterPrompt = BASEBALL_QA_SYSTEM_PROMPT;

  console.log("=== 범위 안 표본 (운영 로그 unsure 실측) ===");
  let beforeAnswered = 0;
  let afterAnswered = 0;
  const flips: string[] = [];
  for (const q of IN_SCOPE_SAMPLES) {
    const b = await classify(apiKey, beforePrompt, q);
    const a = await classify(apiKey, afterPrompt, q);
    if (b === RULE_TERM) beforeAnswered += 1;
    if (a === RULE_TERM) afterAnswered += 1;
    const mark = b === a ? "  " : b !== RULE_TERM && a === RULE_TERM ? "↑↑" : "↓↓";
    if (b !== RULE_TERM && a === RULE_TERM) flips.push(q);
    console.log(`${mark} before=${b.padEnd(20)} after=${a.padEnd(20)} ${q}`);
  }
  console.log(`\n범위 안 답변 판정: before ${beforeAnswered}/${IN_SCOPE_SAMPLES.length} → after ${afterAnswered}/${IN_SCOPE_SAMPLES.length}`);
  if (flips.length > 0) console.log(`새로 열린 질문 ${flips.length}건: ${flips.join(" · ")}`);

  console.log("\n=== 범위 밖 표본 (무회귀) ===");
  const leaked: string[] = [];
  for (const q of OUT_OF_SCOPE_SAMPLES) {
    const a = await classify(apiKey, afterPrompt, q);
    if (a !== NOT_BASEBALL) leaked.push(`${q} -> ${a}`);
    console.log(`   after=${a.padEnd(20)} ${q}`);
  }

  // ② 무회귀가 먼저다 — 범위를 여는 변경의 유일한 위험이다.
  assert.deepEqual(leaked, [], `범위 밖 질문이 열렸다(회귀): ${leaked.join(" / ")}`);
  // ① 개선 — 안 좋아졌으면 이 프롬프트 변경은 근거가 없다.
  assert.ok(
    afterAnswered > beforeAnswered,
    `프롬프트 변경이 실모델 판정을 개선하지 못했다 (before ${beforeAnswered} → after ${afterAnswered}). ` +
      "정적 문자열만 바꾸고 효과를 주장하면 안 된다.",
  );

  console.log(
    `\n✅ 판정 프롬프트 before/after 실모델 검증 PASS — ` +
      `범위 안 ${beforeAnswered}→${afterAnswered} 개선, 범위 밖 누수 0`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
