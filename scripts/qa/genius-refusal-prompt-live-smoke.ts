/**
 * 이 PR 의 **배포 전후** 실모델 비교 — 삼순 2026-08-08 조건 ⑤.
 *
 * ⚠️ 이 게이트는 두 번 방향이 틀렸다가 고쳐졌다. 그 이력을 남긴다 — 같은 실수를 또 한다.
 *
 * 1차(틀림): classifier 가 돌려준 `status` 만 비교했다. `12/12 → 12/12`, 개선 0.
 *    그건 "프롬프트가 효과 없다"가 아니라 **엉뚱한 것을 쟀다**는 뜻이었다. 모델은 before
 *    프롬프트에서도 이미 전부 `BASEBALL_RULE_TERM` 이었고, 유저가 답을 못 받은 진짜 이유는
 *    그 다음 단계인 `validateLlmResponse()` 가 답변 본문을 폐기했기 때문이다.
 *
 * 2차(틀림): 최종 outcome 으로 바꿨지만 **before 도 새 validator 로 쟀다**(삼순 P1).
 *    그러면 `11 → 12` 는 "배포 전 → 배포 후"가 아니라 "old prompt 를 새 validator 에 넣은 값
 *    → after" 다. 이 PR 이 바꾼 것은 프롬프트 **와** validator 둘 다인데, 한쪽을 고정해두면
 *    다른 쪽의 기여가 통째로 숨는다. 실제로 새 validator 가 old prompt 답변까지 살려주고
 *    있어서, 개선폭이 **작아 보이는** 방향으로 왜곡됐다.
 *
 * 3차(현재): **before = 배포 전 형상 전체**(old prompt + old validator),
 *            **after  = 현재 형상 전체**(new prompt + new validator).
 *    old validator 는 `f5c30cf3f` 의 `pipeline.ts` 를 런타임에 꺼내 실제로 import 한다 —
 *    손으로 재구현하면 그게 또 다른 false-green 이다(검증기가 대상을 재구현하면 대상이
 *    죽어도 GREEN — #1110 에서 겪은 유형).
 *
 * 무엇을 고정하는가:
 *  ① 개선   — 범위 안 표본에서 after 의 **최종 답변 성사**가 before 보다 많다.
 *  ② 무회귀 — 범위 밖 표본은 after 에서도 전부 답이 나가지 않는다.
 *  ③ 적대   — 질문에 야구 신호가 있어도 답변이 범위 밖이면 답이 나가지 않는다.
 *             **denylist 단어를 피한** 표본을 포함한다(삼순 P0): `수영 선수`·`FC 서울 프로
 *             구단`·`사생활은 공개되지 않음`. 이건 실모델을 안 태워도 판정되므로 정적으로도
 *             같이 본다 — 모델이 그 문장을 안 만들어주면 축이 통째로 검증되지 않기 때문이다.
 *
 * ⚠️ 조용한 SKIP 금지. 키가 없으면 "통과"가 아니라 "검증 불가"이므로 exit 1 이다.
 * ⚠️ prebuild 에 넣지 않는다 — 네트워크·과금·모델 변동이 걸린 실 provider 게이트다.
 * ⚠️ KPI 표현 주의(삼순): 이 게이트가 보이는 것은 **이 표본들의 병목**이지 운영 `unsure`
 *    전체의 원인이 아니다. 결과 문장도 그렇게만 쓴다.
 *
 * 실행: npm run qa:genius-refusal-prompt-live
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolve } from "node:path";
import {
  BASEBALL_QA_GEMINI_MODEL,
  BASEBALL_QA_SYSTEM_PROMPT,
  buildBaseballQaGeminiRequest,
} from "../../src/lib/baseball-qa/gemini-request";
import { validateLlmResponse } from "../../src/lib/baseball-qa/pipeline";

/**
 * 배포 전 형상의 기준 커밋 — 이 PR 이 ⑤(answer-side 앵커·프롬프트 문맥 강제)를 넣기 **직전**.
 * ①~④ 는 이미 들어가 있는 상태라, 여기서 재는 것은 정확히 ⑤ 의 기여다.
 */
const BEFORE_REF = "f5c30cf3f";

/** 이 PR 이 프롬프트에서 바꾼 두 가지. before prompt 는 배포본에서 이것만 되돌려 만든다. */
const AFTER_CONTEXT_LINES = [
  "답변 첫 문장에는 이 답이 야구 이야기임이 드러나야 한다. 야구·KBO·구단명·포지션 같은 말을",
  "최소 한 번 넣어 문장만 떼어 읽어도 야구 답변임을 알 수 있게 쓴다(예: '야구에서 와이어 투 와이어는 …').",
];

type Validator = (raw: string, question: string) => { kind: string; answer?: string | null };

/**
 * `BEFORE_REF` 시점의 프롬프트·validator 를 **실제로 로드**한다.
 *
 * ⚠️ 손으로 재구현하지 않는다. 재구현하면 "그때 코드가 이랬다" 는 내 기억을 검증하는 꼴이라,
 *   기억이 틀리면 게이트가 조용히 거짓말한다.
 *
 * ⚠️ 스냅샷을 `/tmp` 가 아니라 **원래 디렉터리 옆에** 떨어뜨린다 — 구 pipeline 이
 *   `./context`·`./rag/retrieve` 같은 상대 경로를 import 하기 때문이다. 다른 곳에 두면
 *   모듈 해석이 깨지고, 그 실패를 "구 코드가 원래 그랬다"로 오독하기 쉽다.
 *   `.gitignore` 에 등록돼 있고 finally 에서 지운다.
 */
function loadBeforeShape(): { prompt: string; validate: Validator; cleanup: () => void } {
  const repoRoot = process.cwd();
  const dir = path.join(repoRoot, "src/lib/baseball-qa");
  const snapshot = path.join(dir, `.before-snapshot.${process.pid}.ts`);

  const beforePipeline = execFileSync(
    "git", ["show", `${BEFORE_REF}:src/lib/baseball-qa/pipeline.ts`],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const beforeRequest = execFileSync(
    "git", ["show", `${BEFORE_REF}:src/lib/baseball-qa/gemini-request.ts`],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );

  // 전제 확인 — 두 형상이 실제로 다른가. 같으면 이 비교는 공허하다.
  assert.ok(
    !beforePipeline.includes("ANSWER_SCOPE_ANCHORS"),
    `${BEFORE_REF} 에 이미 answer-side 앵커가 있다 — 기준 커밋이 틀렸다`,
  );
  for (const line of AFTER_CONTEXT_LINES) {
    assert.ok(
      !beforeRequest.includes(line),
      `${BEFORE_REF} 프롬프트에 이미 문맥 강제 문장이 있다 — 기준 커밋이 틀렸다`,
    );
    assert.ok(
      BASEBALL_QA_SYSTEM_PROMPT.includes(line),
      `현재 배포 프롬프트에 문맥 강제 문장이 없다 — 게이트 전제가 깨졌다:\n${line}`,
    );
  }

  writeFileSync(snapshot, beforePipeline, "utf8");
  const cleanup = () => { if (existsSync(snapshot)) rmSync(snapshot); };

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(snapshot) as { validateLlmResponse: Validator };
  assert.equal(typeof mod.validateLlmResponse, "function",
    "구 pipeline 에서 validateLlmResponse 를 못 읽었다");

  // 구 프롬프트는 구 gemini-request 소스에서 직접 뽑는다(모듈 로드 없이 문자열 평가 회피).
  const promptMatch = beforeRequest.match(
    /export const BASEBALL_QA_SYSTEM_PROMPT = \[([\s\S]*?)\]\.join\("\\n"\);/,
  );
  assert.ok(promptMatch, `${BEFORE_REF} 에서 구 프롬프트를 찾지 못했다`);
  const prompt = [...promptMatch[1].matchAll(/^\s*(['"])((?:\\.|(?!\1).)*)\1,\s*$/gmu)]
    .map((m) => m[2].replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\n/g, "\n"))
    .join("\n");
  assert.ok(prompt.length > 500, `구 프롬프트 파싱이 부실하다(${prompt.length}자)`);
  assert.ok(prompt.includes("너는 한국 프로야구(KBO) 도우미다."), "구 프롬프트 첫 줄이 없다");
  assert.notEqual(prompt, BASEBALL_QA_SYSTEM_PROMPT, "before/after 프롬프트가 동일하다");

  return { prompt, validate: mod.validateLlmResponse, cleanup };
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

/** 적대 표본 (실모델 축) — 질문에는 야구 신호가 있는데 답변은 범위 밖. */
const ADVERSARIAL_SAMPLES: readonly string[] = [
  "문현빈 연봉 얼마야?",
  "김도영 여자친구 누구야?",
  "LG 티켓 가격 알려줘",
  "야구 유니폼 세탁법 알려줘",
  "리그 오브 레전드 알려줘",
];

/**
 * **denylist 단어를 피한** 정적 적대 표본 (삼순 2026-08-08 P0/P1).
 *
 * 실모델 축만으로는 이 축이 검증되지 않는다 — 모델이 그 문장을 안 만들어주면 그냥 안 태워지고,
 * 그러면 "누수 0" 이 통과의 증거가 아니라 **미실행의 결과**가 된다.
 * 그래서 답변 문자열을 직접 주입해 배포 validator 로 판정한다.
 */
const STATIC_ADVERSARIAL: ReadonlyArray<readonly [string, string]> = [
  ["박태환 알려줘", "박태환은 수영 선수입니다"],
  ["FC 서울 알려줘", "FC 서울은 한국의 프로 구단입니다"],
  ["김민재 알려줘", "김민재는 국가대표 선발 선수입니다"],
  ["손흥민 알려줘", "손흥민은 국가대표 선수입니다"],
  ["김도영 사생활 알려줘", "그 사생활은 공개되지 않았습니다"],
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

async function callModel(apiKey: string, prompt: string, question: string): Promise<string> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${BASEBALL_QA_GEMINI_MODEL}` +
    `:generateContent?key=${apiKey}`;
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
    return data.candidates?.[0]?.content?.parts
      ?.find((part: { text?: string }) => part.text)?.text ?? "";
  }
  throw new Error(`Gemini API retry exhausted: ${question}`);
}

interface Outcome {
  status: string;
  /** **그 형상의 validator 를 통과해 유저에게 실제로 나간 답**. 이게 판정 기준이다. */
  delivered: string | null;
}

function evaluate(raw: string, question: string, validate: Validator): Outcome {
  let status = "PARSE_FAIL";
  try {
    status = String(JSON.parse(raw).status ?? "PARSE_FAIL");
  } catch {
    // raw 그대로 validator 에 넘긴다 — validator 도 파싱 실패를 unsure 로 처리한다.
  }
  const validated = validate(raw, question);
  return { status, delivered: validated.kind === "answer" ? validated.answer ?? null : null };
}

function truncate(value: string | null, max = 44): string {
  if (!value) return "—";
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

async function main() {
  loadDotEnv(resolve(".env.local"));
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("FAIL: GEMINI_API_KEY 미설정 — 실 provider before/after 게이트는 skip될 수 없다.");
    process.exit(1);
  }

  // ── ⓪ 정적 적대 축 먼저 — 모델 응답에 의존하지 않는다 ─────────────────────
  console.log("=== ⓪ 정적 적대 표본 (denylist 단어를 피한 것들) ===");
  const staticLeaked: string[] = [];
  for (const [question, answer] of STATIC_ADVERSARIAL) {
    const kind = validateLlmResponse(
      JSON.stringify({ status: "ANSWER", answer }), question,
    ).kind;
    if (kind === "answer") staticLeaked.push(`${question} → ${answer}`);
    console.log(`   ${kind === "answer" ? "❌ 답변 나감" : "차단      "}  ${answer}`);
  }

  const before = loadBeforeShape();
  try {
    console.log("\n=== ① 범위 안 표본 — 유저가 실제로 답을 받았는가 ===");
    console.log(`    before = ${BEFORE_REF} 형상(구 프롬프트 + 구 validator)`);
    console.log("    after  = 현재 형상(새 프롬프트 + 새 validator)\n");
    let beforeDelivered = 0;
    let afterDelivered = 0;
    const opened: string[] = [];
    const closed: string[] = [];
    for (const q of IN_SCOPE_SAMPLES) {
      const b = evaluate(await callModel(apiKey, before.prompt, q), q, before.validate);
      const a = evaluate(await callModel(apiKey, BASEBALL_QA_SYSTEM_PROMPT, q), q, validateLlmResponse);
      if (b.delivered) beforeDelivered += 1;
      if (a.delivered) afterDelivered += 1;
      const mark = !b.delivered && a.delivered ? "↑↑" : b.delivered && !a.delivered ? "↓↓" : "  ";
      if (!b.delivered && a.delivered) opened.push(q);
      if (b.delivered && !a.delivered) closed.push(q);
      console.log(`${mark} ${q}`);
      console.log(`     before ${b.status.padEnd(20)} → ${truncate(b.delivered)}`);
      console.log(`     after  ${a.status.padEnd(20)} → ${truncate(a.delivered)}`);
    }
    console.log(
      `\n최종 답변 성사: before ${beforeDelivered}/${IN_SCOPE_SAMPLES.length}` +
        ` → after ${afterDelivered}/${IN_SCOPE_SAMPLES.length}`,
    );
    if (opened.length > 0) console.log(`새로 열린 질문 ${opened.length}건: ${opened.join(" · ")}`);
    if (closed.length > 0) console.log(`⚠️ 새로 닫힌 질문 ${closed.length}건: ${closed.join(" · ")}`);

    console.log("\n=== ② 범위 밖 표본 — 답이 나가면 안 된다 ===");
    const leaked: string[] = [];
    for (const q of OUT_OF_SCOPE_SAMPLES) {
      const a = evaluate(await callModel(apiKey, BASEBALL_QA_SYSTEM_PROMPT, q), q, validateLlmResponse);
      if (a.delivered) leaked.push(`${q} → ${truncate(a.delivered)}`);
      console.log(`   ${a.status.padEnd(20)} ${a.delivered ? "❌ 답변 나감" : "차단"}  ${q}`);
    }

    console.log("\n=== ③ 적대 표본 (실모델) — 질문에 야구 신호가 있어도 답변이 범위 밖이면 차단 ===");
    const adversarialLeaked: string[] = [];
    for (const q of ADVERSARIAL_SAMPLES) {
      const a = evaluate(await callModel(apiKey, BASEBALL_QA_SYSTEM_PROMPT, q), q, validateLlmResponse);
      if (a.delivered) adversarialLeaked.push(`${q} → ${truncate(a.delivered)}`);
      console.log(`   ${a.status.padEnd(20)} ${a.delivered ? "❌ 답변 나감" : "차단"}  ${q}`);
    }

    // 무회귀가 먼저다 — 범위를 여는 변경의 유일한 위험이다.
    assert.deepEqual(staticLeaked, [],
      `denylist 를 피한 범위밖 답변이 나갔다(삼순 P0 재현): ${staticLeaked.join(" / ")}`);
    assert.deepEqual(leaked, [], `범위 밖 질문에 답이 나갔다(회귀): ${leaked.join(" / ")}`);
    assert.deepEqual(adversarialLeaked, [],
      `질문 신호를 이유로 범위밖 답변이 나갔다: ${adversarialLeaked.join(" / ")}`);
    // 개선 — 안 좋아졌으면 이 변경은 근거가 없다.
    assert.ok(
      afterDelivered > beforeDelivered,
      `배포 전후로 최종 답변 성사가 개선되지 않았다 (before ${beforeDelivered} → after ${afterDelivered}).`,
    );

    console.log(
      `\n✅ 배포 전후(${BEFORE_REF} → 현재) 실모델 outcome PASS — ` +
        `이 표본 ${IN_SCOPE_SAMPLES.length}개에서 답변 성사 ${beforeDelivered}→${afterDelivered}, ` +
        `범위밖 누수 0, 적대 누수 0(실모델 ${ADVERSARIAL_SAMPLES.length} + 정적 ${STATIC_ADVERSARIAL.length})` +
        `\n   (표본 단위 결과다. 운영 unsure 전체의 원인을 확정하는 수치가 아니다.)`,
    );
  } finally {
    before.cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
