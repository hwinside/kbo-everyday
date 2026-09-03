#!/usr/bin/env node
// 크관 채팅 비속어 필터 P0 골든셋 회귀 게이트.
// 실행: npx tsx scripts/qa/chat-profanity.mjs [--selftest]
// 오탐 최소화가 최우선 — normal_pass 오탐 0 은 하드 게이트.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const GOLDEN = resolve(ROOT, "state/qa/chat-profanity-golden.json");

const { classify } = await import(resolve(ROOT, "src/lib/chat/profanity/index.ts"));

const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));

const isHard = (v) => v === "hard_legacy" || v === "hard_new";

/**
 * 골든셋을 classifyFn 으로 채점. 실패 목록 반환.
 * 축:
 *  - normal_pass: verdict === 'pass' (오탐 0, 하드 게이트)
 *  - soft:        verdict === 'soft'
 *  - hard:        isHard(verdict)
 *  - bypass:      isHard(verdict) (전체 PASS 우회 금지)
 */
function runGate(classifyFn) {
  const fails = { normal_pass: [], soft: [], hard: [], bypass: [] };
  for (const s of golden.normal_pass) {
    const v = classifyFn(s).verdict;
    if (v !== "pass") fails.normal_pass.push(`${s} → ${v}`);
  }
  for (const s of golden.soft) {
    const v = classifyFn(s).verdict;
    if (v !== "soft") fails.soft.push(`${s} → ${v}`);
  }
  for (const s of golden.hard) {
    const v = classifyFn(s).verdict;
    if (!isHard(v)) fails.hard.push(`${s} → ${v}`);
  }
  for (const s of golden.bypass) {
    const v = classifyFn(s).verdict;
    if (!isHard(v)) fails.bypass.push(`${s} → ${v}`);
  }
  const total = Object.values(fails).reduce((a, b) => a + b.length, 0);
  return { fails, total };
}

function counts() {
  return {
    normal_pass: golden.normal_pass.length,
    soft: golden.soft.length,
    hard: golden.hard.length,
    bypass: golden.bypass.length,
  };
}

const SELFTEST = process.argv.includes("--selftest");

if (!SELFTEST) {
  const { fails, total } = runGate(classify);
  const c = counts();
  for (const axis of ["normal_pass", "soft", "hard", "bypass"]) {
    const failed = fails[axis].length;
    const passed = c[axis] - failed;
    console.log(`[${axis}] ${passed}/${c[axis]} PASS` + (failed ? ` — FAIL: ${fails[axis].join(", ")}` : ""));
  }
  if (total === 0) {
    console.log("\n✅ qa:chat-profanity GREEN — 오탐 0, HARD 전건 검출, 우회 차단");
    process.exit(0);
  } else {
    console.error(`\n❌ qa:chat-profanity RED — ${total} 건 실패`);
    process.exit(1);
  }
} else {
  // 결함주입: 각 mutant 에서 게이트가 RED(실패 감지)를 내는지 검증.
  const mutants = {
    "all-pass (전체 PASS 우회)": () => ({ verdict: "pass", matches: [] }),
    "all-hard (과잉 차단)": () => ({ verdict: "hard_legacy", matches: [] }),
    "all-soft": () => ({ verdict: "soft", matches: [] }),
    "no-boundary (새끼 경계 무시 시뮬)": (s) =>
      s.includes("새끼") ? { verdict: "hard_legacy", matches: [] } : classify(s),
    "bypass-whole-pass (반례 걸리면 문장 전체 PASS)": (s) =>
      /강한남자|새끼손가락/.test(s) ? { verdict: "pass", matches: [] } : classify(s),
  };
  let selfFails = 0;
  for (const [name, fn] of Object.entries(mutants)) {
    const { total } = runGate(fn);
    const caught = total > 0;
    console.log(`${caught ? "✅ 감지" : "❌ 놓침"} mutant: ${name} (실패 ${total}건)`);
    if (!caught) selfFails++;
  }
  // 정상 classify 는 selftest 에서 GREEN 이어야
  const real = runGate(classify);
  console.log(`${real.total === 0 ? "✅" : "❌"} real classify GREEN (실패 ${real.total}건)`);
  if (real.total !== 0) selfFails++;
  if (selfFails === 0) {
    console.log("\n✅ selftest GREEN — 게이트가 모든 mutant 를 RED 로 잡고 real 은 GREEN");
    process.exit(0);
  } else {
    console.error(`\n❌ selftest RED — ${selfFails} 개 mutant 미감지/오판`);
    process.exit(1);
  }
}
