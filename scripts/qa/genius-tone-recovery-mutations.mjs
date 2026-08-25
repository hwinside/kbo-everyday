#!/usr/bin/env node
/**
 * A′ 톤 회수 검출력 — 실제 production seam을 훼손하고 `qa:genius-tone-recovery` RED 확인.
 * 패치 MISS/게이트 비실행/실패 ID 부재는 PASS가 아니다. 매 mutant 후 원본을 즉시 복원한다.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const TONE = "src/lib/baseball-qa/tone.ts";
const PIPELINE = "src/lib/baseball-qa/pipeline.ts";
const REQUEST = "src/lib/baseball-qa/gemini-request.ts";
const TARGETS = [TONE, PIPELINE, REQUEST];
const originals = new Map(TARGETS.map((file) => [file, fs.readFileSync(file, "utf8")]));
const restore = () => { for (const [file, source] of originals) fs.writeFileSync(file, source); };
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { restore(); process.exit(130); });

const mutations = [
  {
    name: "M1 아니에요 mapping 삭제",
    file: TONE,
    re: /  \["아니에요", "아닙니다"\],\n/,
    to: "",
  },
  {
    name: "M2 아니에요 비문으로 오염",
    file: TONE,
    re: /\["아니에요", "아닙니다"\]/,
    to: '["아니에요", "아니입니다"]',
  },
  {
    name: "M3 미등록 거예요 과변환 주입",
    file: TONE,
    re: /const FORMAL_TONE_WORD_MAP = new Map<string, string>\(\[\n/,
    to: 'const FORMAL_TONE_WORD_MAP = new Map<string, string>([\n  ["거예요", "거입니다"],\n',
  },
  {
    name: "M4 provider request에서 폐기 원문 제거",
    file: REQUEST,
    re: /parts: \[\{ text: `<원문>\\n\$\{originalAnswer\}\\n<\/원문>` \}\]/,
    to: 'parts: [{ text: "<원문>삭제됨</원문>" }]',
  },
  {
    name: "M5 rewrite 내용보존 게이트 우회",
    file: PIPELINE,
    re: /&& isToneRewriteContentPreserving\(first\.rejectedAnswer, retriedValidation\.answer\);/,
    to: "&& true;",
  },
  {
    name: "M7 모호쌍 보여요 rewrite allowlist 재주입",
    file: TONE,
    re: /const FORMAL_TONE_REWRITE_WORD_MAP = new Map<string, string>\(\[\n/,
    to: 'const FORMAL_TONE_REWRITE_WORD_MAP = new Map<string, string>([\n  ["\ubcf4\uc5ec\uc694", "\ubcf4\uc5ec\uc90d\ub2c8\ub2e4"],\n',
  },
  {
    name: "M8 scope 판정을 tone 뒤로 되돌림(이중결함 rewrite 소비)",
    file: PIPELINE,
    re: /  if \(!answerInQuestionScope\(question, toned\)\) \{\n    return \{ kind: "unsure", reason: "out_of_question_scope" \};\n  \}\n  if \(toneFailed\) \{\n    return \{ kind: "unsure", reason: "tone_noncompliant", rejectedAnswer: toned \};\n  \}\n/,
    to: '  if (toneFailed) {\n    return { kind: "unsure", reason: "tone_noncompliant", rejectedAnswer: toned };\n  }\n  if (!answerInQuestionScope(question, toned)) {\n    return { kind: "unsure", reason: "out_of_question_scope" };\n  }\n',
  },
  {
    name: "M6 rewrite 토큰 합산 제거",
    file: PIPELINE,
    re: /inputTokens: sumTokens\(llm\.inputTokens, retry\.inputTokens\),/,
    to: "inputTokens: retry.inputTokens,",
  },
];

let detected = 0;
try {
  for (const mutation of mutations) {
    restore();
    const source = fs.readFileSync(mutation.file, "utf8");
    const matches = source.match(mutation.re)?.length ?? 0;
    if (matches !== 1) {
      console.error(`[GTR-MUT-ANCHOR-MISS] ${mutation.name}: matches=${matches}`);
      process.exitCode = 1;
      break;
    }
    const mutant = source.replace(mutation.re, mutation.to);
    if (mutant === source) {
      console.error(`[GTR-MUT-NOOP] ${mutation.name}`);
      process.exitCode = 1;
      break;
    }
    fs.writeFileSync(mutation.file, mutant);
    const run = spawnSync("npm", ["run", "qa:genius-tone-recovery"], { encoding: "utf8", timeout: 120_000 });
    const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    const red = run.status !== 0 && output.includes("[GTR-FAIL]");
    if (!red) {
      console.error(`[GTR-MUT-UNDETECTED] ${mutation.name}: exit=${run.status}`);
      console.error(output.slice(-1500));
      process.exitCode = 1;
      break;
    }
    detected += 1;
    console.log(`RED ${mutation.name}`);
  }
} finally {
  restore();
}
if (!process.exitCode) console.log(`ALL RED (${detected}/${mutations.length})`);
