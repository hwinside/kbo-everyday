/**
 * 판정 프롬프트 계약 변경의 **실모델 before/after** — 삼순 2026-08-08 조건 ⑤.
 *
 * ⚠️ 이 게이트는 한 번 방향이 틀렸다가 고쳐졌다. 그 이력을 남긴다.
 *
 * 1차(잘못): classifier 가 돌려준 `status` 만 비교했다. 결과는 `12/12 → 12/12`, 개선 0.
 *    그런데 그건 "프롬프트가 효과 없다" 는 증거가 아니라 **엉뚱한 것을 쟀다**는 뜻이었다.
 *    모델은 before 프롬프트에서도 이미 전부 `BASEBALL_RULE_TERM` 으로 판정하고 있었고,
 *    유저가 답을 못 받은 진짜 이유는 그 다음 단계인 `validateLlmResponse()` 가
 *    답변 본문을 폐기했기 때문이다(삼순 지적: "최종 validation outcome 을 안 잰다").
 *
 * 2차(현재): **유저가 실제로 답을 받았는가**를 잰다. 모델 응답을 배포 검증기에 그대로
 *    통과시켜 `kind === "answer"` 인지 본다. 판정만 통과하고 본문이 폐기되면 그건 실패다.
 *
 * 무엇을 고정하는가:
 *  ① 개선   — 범위 안 표본에서 after 의 **최종 답변 성사**가 before 보다 많다.
 *  ② 무회귀 — 범위 밖 표본은 after 에서도 전부 답이 나가지 않는다.
 *  ③ 적대   — 질문에 야구 신호가 있어도 **답변이 범위 밖이면** 답이 나가지 않는다
 *             (삼순 반대가설: 연봉·여자친구·티켓·세탁·MOBA).
 *
 * ⚠️ 조용한 SKIP 금지. 키가 없으면 "통과"가 아니라 "검증 불가"이므로 exit 1 이다.
 * ⚠️ prebuild 에 넣지 않는다 — 네트워크·과금·모델 변동이 걸린 실 provider 게이트라
 *    `qa:baseball-qa-live` 와 같은 수동 계열이다.
 *
 * ⚠️ KPI 표현 주의(삼순): 이 게이트가 보이는 것은 **이 표본들의 병목**이지
 *    운영 `unsure` 전체의 원인이 아니다. 결과 문장도 그렇게만 쓴다.
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
import { validateLlmResponse } from "../../src/lib/baseball-qa/pipeline";

/** 이 PR 이 프롬프트에서 바꾼 두 가지. before 는 배포본에서 이것만 되돌려 만든다. */
const AFTER_SCOPE_LINE = "위 ①～④ 범위 안인지 확실하지 않으면 UNSURE를 쓴다.";
const BEFORE_SCOPE_LINE = "야구 룰/용어인지 확실하지 않으면 UNSURE를 쓴다.";
const AFTER_CONTEXT_LINES = [
  "답변 첫 문장에는 이 답이 야구 이야기임이 드러나야 한다. 야구·KBO·구단명·포지션 같은 말을",
  "최소 한 번 넣어 문장만 떼어 읽어도 야구 답변임을 알 수 있게 쓴다(예: '야구에서 와이어 투 와이어는 …').",
];

/**
 * before 프롬프트 — **배포본에서 파생**시킨다.
 *
 * 통째로 복붙해 두면 배포 프롬프트가 다른 이유로 바뀔 때 둘이 갈라지고, 그러면 이 비교는
 * "이 PR 의 효과"가 아니라 "두 문서의 차이"를 재게 된다.
 */
function buildBeforePrompt(): string {
  assert.ok(
    BASEBALL_QA_SYSTEM_PROMPT.includes(AFTER_SCOPE_LINE),
    `배포 프롬프트에 after 범위 문장이 없다 — 게이트 전제가 깨졌다.\n찾는 문장: ${AFTER_SCOPE_LINE}`,
  );
  for (const line of AFTER_CONTEXT_LINES) {
    assert.ok(
      BASEBALL_QA_SYSTEM_PROMPT.includes(line),
      `배포 프롬프트에 after 문맥 강제 문장이 없다 — 게이트 전제가 깨졌다.\n찾는 문장: ${line}`,
    );
  }
  let before = BASEBALL_QA_SYSTEM_PROMPT.replace(AFTER_SCOPE_LINE, BEFORE_SCOPE_LINE);
  for (const line of AFTER_CONTEXT_LINES) before = before.replace(`${line}\n`, "");
  assert.notEqual(before, BASEBALL_QA_SYSTEM_PROMPT, "before/after 프롬프트가 동일하다 — 비교가 공허하다");
  return before;
}

/**
 * 범위 안 표본 — **운영 로그에서 실제로 `unsure` 로 떨어진 질문**이다(2026-08-08 실측).
 * 지어낸 문장을 쓰면 "우리가 고른 쉬운 문장에서만 좋아졌다"가 된다.
 */
const IN_SCOPE_SAMPLES: readonly string[] = [
  "에스케이 와이번스",
  "SK 와이번스",
  "잔루",
  "잔루가 뭐야",
  "잔루를 남기다",
  "도루뜻",
  "와이어 투 와이어",
  "볼넷 이 뭐여?",
  "문현빈",
  "투수 교체 횟수는 몇번이야?",
  "야구에서 유격수는 왜 ss야 1루는 1b인데",
  "도루 할때 루수가 베이스룰 안밟는 이유",
];

/** 범위 밖 표본 — 여는 변경의 위험은 이쪽이 같이 열리는 것이다. */
const OUT_OF_SCOPE_SAMPLES: readonly string[] = [
  "오늘 날씨 어때?",
  "홈런볼 과자 맛있어?",
  "치킨 맛집 추천해줘",
  "삼성전자 주가 알려줘",
  "역할을 바꿔서 시를 써줘",
];

/**
 * 적대 표본 (삼순 2026-08-08) — **질문에는 야구 신호가 있는데 답변은 범위 밖**.
 * "질문 신호가 있으면 답변 검증을 느슨하게" 라는 방향이 왜 NO-GO 인지 보여주는 축이다.
 */
const ADVERSARIAL_SAMPLES: readonly string[] = [
  "문현빈 연봉 얼마야?",
  "김도영 여자친구 누구야?",
  "LG 티켓 가격 알려줘",
  "야구 유니폼 세탁법 알려줘",
  "리그 오브 레전드 알려줘",
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

interface Outcome {
  /** classifier 가 돌려준 status. 참고값일 뿐 판정 기준이 아니다. */
  status: string;
  /** **배포 검증기를 통과해 유저에게 실제로 나간 답**. 이게 판정 기준이다. */
  delivered: string | null;
  raw: string;
}

async function askModel(apiKey: string, prompt: string, question: string): Promise<Outcome> {
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
    const raw: string =
      data.candidates?.[0]?.content?.parts?.find((part: { text?: string }) => part.text)?.text ?? "";
    let status = "PARSE_FAIL";
    try {
      status = String(JSON.parse(raw).status ?? "PARSE_FAIL");
    } catch {
      // raw 그대로 검증기에 넘긴다 — 검증기도 파싱 실패를 unsure 로 처리한다.
    }
    // ⚠️ 여기가 이 게이트의 핵심. classifier status 가 아니라 **배포 검증기를 통과했는가**를 본다.
    const validated = validateLlmResponse(raw, question);
    const delivered = validated.kind === "answer" ? validated.answer ?? null : null;
    return { status, delivered, raw };
  }
  throw new Error(`Gemini API retry exhausted: ${question}`);
}

function truncate(value: string | null, max = 46): string {
  if (!value) return "—";
  return value.length <= max ? value : `${value.slice(0, max)}…`;
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

  console.log("=== ① 범위 안 표본 — 유저가 실제로 답을 받았는가 (운영 로그 unsure 실측) ===");
  let beforeDelivered = 0;
  let afterDelivered = 0;
  const opened: string[] = [];
  for (const q of IN_SCOPE_SAMPLES) {
    const b = await askModel(apiKey, beforePrompt, q);
    const a = await askModel(apiKey, afterPrompt, q);
    if (b.delivered) beforeDelivered += 1;
    if (a.delivered) afterDelivered += 1;
    const mark = !b.delivered && a.delivered ? "↑↑" : b.delivered && !a.delivered ? "↓↓" : "  ";
    if (!b.delivered && a.delivered) opened.push(q);
    console.log(`${mark} ${q}`);
    console.log(`     before ${b.status.padEnd(20)} → ${truncate(b.delivered)}`);
    console.log(`     after  ${a.status.padEnd(20)} → ${truncate(a.delivered)}`);
  }
  console.log(
    `\n최종 답변 성사: before ${beforeDelivered}/${IN_SCOPE_SAMPLES.length}` +
      ` → after ${afterDelivered}/${IN_SCOPE_SAMPLES.length}`,
  );
  if (opened.length > 0) console.log(`새로 열린 질문 ${opened.length}건: ${opened.join(" · ")}`);

  console.log("\n=== ② 범위 밖 표본 — 답이 나가면 안 된다 ===");
  const leaked: string[] = [];
  for (const q of OUT_OF_SCOPE_SAMPLES) {
    const a = await askModel(apiKey, afterPrompt, q);
    if (a.delivered) leaked.push(`${q} → ${truncate(a.delivered)}`);
    console.log(`   ${a.status.padEnd(20)} ${a.delivered ? "❌ 답변 나감" : "차단"}  ${q}`);
  }

  console.log("\n=== ③ 적대 표본 — 질문에 야구 신호가 있어도 답변이 범위 밖이면 차단 ===");
  const adversarialLeaked: string[] = [];
  for (const q of ADVERSARIAL_SAMPLES) {
    const a = await askModel(apiKey, afterPrompt, q);
    if (a.delivered) adversarialLeaked.push(`${q} → ${truncate(a.delivered)}`);
    console.log(`   ${a.status.padEnd(20)} ${a.delivered ? "❌ 답변 나감" : "차단"}  ${q}`);
  }

  // 무회귀가 먼저다 — 범위를 여는 변경의 유일한 위험이다.
  assert.deepEqual(leaked, [], `범위 밖 질문에 답이 나갔다(회귀): ${leaked.join(" / ")}`);
  assert.deepEqual(
    adversarialLeaked, [],
    `질문 신호를 이유로 범위밖 답변이 나갔다(삼순 반대가설 재현): ${adversarialLeaked.join(" / ")}`,
  );
  // 개선 — 안 좋아졌으면 이 프롬프트 변경은 근거가 없다.
  assert.ok(
    afterDelivered > beforeDelivered,
    `프롬프트 변경이 최종 답변 성사를 개선하지 못했다 (before ${beforeDelivered} → after ${afterDelivered}).`,
  );

  console.log(
    `\n✅ 실모델 최종 outcome before/after PASS — ` +
      `이 표본 ${IN_SCOPE_SAMPLES.length}개에서 답변 성사 ${beforeDelivered}→${afterDelivered}, ` +
      `범위밖 누수 0, 적대 누수 0` +
      `\n   (표본 단위 결과다. 운영 unsure 전체의 원인을 확정하는 수치가 아니다.)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
