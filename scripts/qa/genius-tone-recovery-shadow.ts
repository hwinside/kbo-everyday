#!/usr/bin/env tsx
/**
 * A′ ② 실 provider shadow — A0 잔존 런의 **부분 정규화된 기존 답변**만 rewrite한다.
 * DM/DB/캐시/제품 경로를 전혀 호출하지 않는다. provider 응답을 보존 게이트로 판정하고
 * 성공률·지연·입출력 토큰(비용 분모)을 재현 가능한 JSON으로 남긴다.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { BASEBALL_QA_GEMINI_MODEL, buildBaseballQaToneRewriteRequest } from "../../src/lib/baseball-qa/gemini-request";
import { validateLlmResponse } from "../../src/lib/baseball-qa/pipeline";
import { isToneRewriteContentPreserving } from "../../src/lib/baseball-qa/tone";

interface Fixture {
  kind: string;
  sourceSha256: string;
  rows: Array<{ runId: string; rep: number; afterFiniteMap: string; finiteMappedSentences: number }>;
}

async function main(): Promise<void> {
const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error("GEMINI_API_KEY missing");
const fixturePath = "scripts/qa/fixtures/genius-tone-a0-rewrite-residual.json";
const outputPath = process.argv[2] ?? "scripts/qa/fixtures/genius-tone-a0-rewrite-residual-shadow.json";
const fixtureBytes = readFileSync(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as Fixture;
if (fixture.kind !== "genius-tone-a0-rewrite-residual-v1" || fixture.rows.length === 0) {
  throw new Error(`fixture contract mismatch: ${fixture.kind}/${fixture.rows.length}`);
}
const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${BASEBALL_QA_GEMINI_MODEL}:generateContent?key=${key}`;
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
};

const results: Array<Record<string, unknown>> = [];
for (const [index, row] of fixture.rows.entries()) {
  const started = performance.now();
  let status = 0;
  let rawText = "";
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let error: string | null = null;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBaseballQaToneRewriteRequest(row.afterFiniteMap)),
      signal: AbortSignal.timeout(20_000),
    });
    status = response.status;
    if (!response.ok) throw new Error(`provider HTTP ${response.status}`);
    const data = await response.json();
    rawText = data.candidates?.[0]?.content?.parts?.find((part: { text?: string }) => part.text)?.text ?? "";
    inputTokens = data.usageMetadata?.promptTokenCount ?? null;
    outputTokens = data.usageMetadata?.candidatesTokenCount ?? null;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const elapsedMs = Math.round(performance.now() - started);
  const validated = error ? { kind: "unsure" as const } : validateLlmResponse(rawText, "야구 용어 질문");
  const rewritten = validated.kind === "answer" ? validated.answer ?? "" : "";
  const tonePass = rewritten.length > 0;
  const preservationPass = tonePass && isToneRewriteContentPreserving(row.afterFiniteMap, rewritten);
  results.push({
    index,
    runId: row.runId,
    rep: row.rep,
    inputSha256: sha(row.afterFiniteMap),
    outputSha256: rewritten ? sha(rewritten) : null,
    // 원문은 fixture[index]가 SSOT — 여기 중복 저장하지 않아 원장 크기를 줄인다.
    rewritten: rewritten || null,
    providerStatus: status,
    tonePass,
    preservationPass,
    accepted: tonePass && preservationPass,
    elapsedMs,
    inputTokens,
    outputTokens,
    error,
  });
  console.log(`${index + 1}/${fixture.rows.length} accepted=${tonePass && preservationPass} ${elapsedMs}ms`);
}
const latencies = results.map((r) => Number(r.elapsedMs));
const total = results.length;
const accepted = results.filter((r) => r.accepted === true).length;
const tonePass = results.filter((r) => r.tonePass === true).length;
const preservationPass = results.filter((r) => r.preservationPass === true).length;
const totalInputTokens = results.reduce((sum, r) => sum + Number(r.inputTokens ?? 0), 0);
const totalOutputTokens = results.reduce((sum, r) => sum + Number(r.outputTokens ?? 0), 0);
const output = {
  kind: "genius-tone-a0-rewrite-residual-shadow-v1",
  at: new Date().toISOString(),
  model: BASEBALL_QA_GEMINI_MODEL,
  fixtureSha256: sha(fixtureBytes.toString("utf8")),
  sourceSha256: fixture.sourceSha256,
  summary: {
    total,
    tonePass,
    preservationPass,
    accepted,
    successRate: accepted / total,
    latencyMs: {
      min: Math.min(...latencies),
      median: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: Math.max(...latencies),
    },
    tokens: {
      inputTotal: totalInputTokens,
      outputTotal: totalOutputTokens,
      inputMean: totalInputTokens / total,
      outputMean: totalOutputTokens / total,
    },
    // 🔴 2026-08-25 삼순 P1 교정. "3차 0" 은 틀렸다 — stat `RULE_TERM` 분기는
    //    의도 1 + 일반답 1 이 선행하므로 rewrite 가 붙으면 총 3회가 된다.
    //    불변은 "rewrite 는 처리당 최대 1회"이며, 총 호출 상한은 경로별로 2회(일반) / 3회(stat)이다.
    productionCallUpperBound:
      "tone_noncompliant 중 ① 미회수 · 범위안 · 비의문 잔존에만 rewrite 1회; "
      + "rewrite 최대 1회 / production full seam 총 최대 4회"
      + "(stat RULE_TERM: normalizeQuestionLlm+의도+일반답+rewrite), "
      + "일반 경로 총 최대 3회(normalizeQuestionLlm+일반답+rewrite)",
  },
  results,
};
writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify(output.summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
