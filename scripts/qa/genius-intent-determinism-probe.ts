/**
 * 분류기 결정론 프로브 — 삼순 2026-08-31 지시 ①.
 *
 * ## 답하려는 질문
 *
 * 1차/2차 진단에서 같은 질문이 회차마다 다른 intent 를 받았다:
 *     방금 점수 어떻게 냈어?   BASEBALL → FOLLOWUP
 *     안해주면                FOLLOWUP → BASEBALL
 *     질문답헤줘              SMALLTALK_SAFE → FOLLOWUP
 *
 * 그런데 그 두 런은 **입력이 같았다는 보장이 없다**(2차에서 맥락 주입을 추가했다).
 * 즉 "provider 가 비결정적이다" 는 아직 증명되지 않았고, 내가 입력을 바꿔놓고
 * provider 탓을 했을 수 있다.
 *
 * 그래서 **실제 나가는 request body 의 sha256 을 고정**하고, 같은 해시에서 N회 돌려
 * 판정이 갈리는지 본다. 해시가 다르면 그건 provider 비결정성이 아니라 내 입력 변동이다.
 *
 * ## 관측 방법
 *
 * `globalThis.fetch` 를 투명 래퍼로 감싸 **production `classifyIntent` 가 만든 body 를
 * 그대로 복사**한다. 호출을 바꾸지 않는다 — 프로덕션 코드에 QA 분기를 심으면 그 자체가
 * 측정 대상을 오염시킨다(2026-08-22 M90).
 *
 * 실행:
 *   npx tsx --require ./scripts/qa/_a0-preload.cjs scripts/qa/genius-intent-determinism-probe.ts
 *   ... --reps 10
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { classifyIntent } from "../../src/lib/baseball-qa/server";
import { parseIntentResponse } from "../../src/lib/baseball-qa/intent";

const LEDGER = "/Users/harinclaw/.openclaw/workspace/state/yaj-48h/failure-ledger-claim-20260831.json";
const OUT = "/Users/harinclaw/.openclaw/workspace/state/yaj-48h/intent-determinism-20260831.json";

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const REPS = Number(arg("reps", "10"));

/** 회차 사이에 갈린 것으로 관측된 3건 (삼순 지시: 이 3건만 먼저 10회). */
const FLIPPED = ["방금 점수 어떻게 냈어?", "안해주면", "질문답헤줘"];
/** 대조군 — 두 런에서 안 갈린 clear case. 이쪽도 갈리면 문제의 성격이 다르다. */
const CLEAR = ["사랑해요", "그게뭔소리야", "오늘 대구 날씨 어떨거 같아", "보크가 뭐야?"];

interface Entry {
  question: string;
  category: string;
  context?: { question: string; answer: string } | null;
}

/** 실제 나간 request body 를 포획한다(호출 자체는 그대로 통과). */
let lastBody: string | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (typeof init?.body === "string") lastBody = init.body;
  return realFetch(input, init);
}) as typeof fetch;

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

async function main() {
  const ledger = JSON.parse(readFileSync(LEDGER, "utf8")) as { entries: Entry[] };
  const byQuestion = new Map<string, Entry>();
  for (const e of ledger.entries) if (!byQuestion.has(e.question)) byQuestion.set(e.question, e);

  const targets = [...FLIPPED.map((q) => ({ q, group: "flipped" })), ...CLEAR.map((q) => ({ q, group: "clear" }))];
  console.log(`[determinism] ${targets.length}건 × ${REPS}rep = ${targets.length * REPS}콜\n`);

  const rows: Array<Record<string, unknown>> = [];
  let anyFail = false;

  for (const { q, group } of targets) {
    const entry = byQuestion.get(q);
    const ctx = entry?.context ?? undefined;
    const intents: string[] = [];
    const bodyHashes = new Set<string>();
    const answers = new Set<string>();

    for (let i = 0; i < REPS; i += 1) {
      lastBody = null;
      let intent = "ERROR";
      let answer = "";
      try {
        const r = await classifyIntent(q, ctx);
        const d = parseIntentResponse(r.text, { question: q, previousAnswer: ctx?.answer ?? null });
        intent = d.intent;
        answer = d.answer ?? "";
      } catch (e) {
        intent = `ERROR:${(e as Error).message.slice(0, 30)}`;
      }
      intents.push(intent);
      if (lastBody) bodyHashes.add(sha(lastBody));
      answers.add(answer);
    }

    const uniqueIntents = [...new Set(intents)];
    // 🔴 판정: body hash 가 1개인데 intent 가 여러 개면 **provider 비결정성**이 확정된다.
    //   body hash 가 여러 개면 내 입력이 흔들린 것이라 provider 탓을 할 수 없다.
    const bodyStable = bodyHashes.size === 1;
    const intentStable = uniqueIntents.length === 1;
    const verdict = !bodyStable
      ? "입력변동(내 탓)"
      : intentStable ? "결정론" : "provider 비결정성";
    if (bodyStable && !intentStable) anyFail = true;

    const mark = intentStable ? "✅" : "🔴";
    console.log(`${mark} [${group}] ${q.slice(0, 26).padEnd(28)} body#${bodyHashes.size} intent×${uniqueIntents.length} → ${verdict}`);
    if (!intentStable) {
      const tally: Record<string, number> = {};
      for (const it of intents) tally[it] = (tally[it] ?? 0) + 1;
      console.log(`     분포: ${JSON.stringify(tally)}`);
      console.log(`     body sha: ${[...bodyHashes].join(", ")}`);
    }
    rows.push({
      question: q, group, hasContext: Boolean(ctx), reps: REPS,
      bodyHashes: [...bodyHashes], intents, uniqueIntents, answerVariants: answers.size, verdict,
    });
  }

  const flippedRows = rows.filter((r) => r.group === "flipped");
  const clearRows = rows.filter((r) => r.group === "clear");
  const unstable = (rs: typeof rows) => rs.filter((r) => (r.uniqueIntents as string[]).length > 1).length;
  console.log(`\n[결과] flipped ${unstable(flippedRows)}/${flippedRows.length} 불안정 · clear ${unstable(clearRows)}/${clearRows.length} 불안정`);
  console.log(anyFail
    ? "→ body 고정 상태에서도 판정이 갈린다 = provider 비결정성 확정. 재생(durable replay)이 필요하다."
    : "→ body 고정 시 판정이 안정적이다. 앞선 관측 차이는 입력 변동 때문이었다.");

  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), reps: REPS, rows }, null, 1));
  console.log(`\n원장: ${OUT}`);
}

void main();
