#!/usr/bin/env node
// P0 회귀 + 실제 소스 결함주입. 실행/판정은 리뷰어가 수행한다.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = resolve(ROOT, "src/lib/chat/profanity");
const core = await import(pathToFileURL(join(SOURCE, "index.ts")).href);
const golden = JSON.parse(readFileSync(resolve(ROOT, "state/qa/chat-profanity-golden.json"), "utf8"));
const priority = { pass: 0, soft: 1, hard_new: 2, hard_legacy: 3 };
const registry = [
  ...core.HARD_LEGACY.map((rule) => [rule, "hard_legacy"]),
  [core.SAEKKI_RULE, "hard_legacy"],
  ...core.HARD_NEW.map((rule) => [rule, "hard_new"]),
  ...core.THREAT_WORDS.map((rule) => [rule, "hard_new"]),
  ["ㅗ", "hard_new"],
];
// 사전·fixture 쌍방 누락/중복은 시작부터 fail-close.
assert.equal(new Set(golden.rules.map((r) => r.rule)).size, golden.rules.length);
assert.deepEqual(golden.rules.map((r) => [r.rule, r.tier]).sort(), registry.sort());
for (const r of golden.rules) {
  assert.ok(r.positive.length && r.negative.length, `양/음성 fixture 없음: ${r.rule}`);
}
for (const axis of ["normal_pass", "soft", "bypass"]) assert.ok(golden[axis].length, `빈 축: ${axis}`);

function runGate(classify) {
  const failures = [];
  let checks = 0;
  function check(label, text, validate) {
    checks++;
    const result = classify(text);
    try {
      assert.ok(Object.hasOwn(priority, result.verdict));
      assert.ok(Array.isArray(result.matches));
      const derived = result.matches.reduce((v, m) => priority[m.tier] > priority[v] ? m.tier : v, "pass");
      assert.equal(result.verdict, derived, "verdict/matches 불일치");
      validate(result);
    } catch (error) {
      failures.push(`${label}: ${JSON.stringify(text)} — ${error.message}`);
    }
  }
  for (const text of golden.normal_pass) check("normal", text, (r) => assert.equal(r.verdict, "pass"));
  for (const text of golden.soft) check("soft", text, (r) => assert.equal(r.verdict, "soft"));
  for (const fixture of golden.rules) {
    for (const text of fixture.positive) check(`positive/${fixture.rule}`, text, (r) => {
      assert.ok(r.matches.some((m) => m.rule === fixture.rule && m.tier === fixture.tier), "exact rule/tier 미검출");
    });
    for (const text of fixture.negative) check(`negative/${fixture.rule}`, text, (r) => assert.equal(r.verdict, "pass"));
  }
  for (const fixture of golden.bypass) check("span-bypass", fixture.text, (r) => {
    assert.ok(r.matches.some((m) => ["rule", "tier", "index", "start", "end"].every((key) => m[key] === fixture[key])), "exact span 미검출");
    // 동일 rule의 면책 구간까지 함께 노출시키는 과잉 매칭도 감지.
    assert.equal(r.matches.filter((m) => m.rule === fixture.rule).length, 1);
  });
  return { checks, failures };
}

const real = runGate(core.classify);
if (real.failures.length) {
  console.error(real.failures.join("\n"));
  throw new Error(`real RED: ${real.failures.length}/${real.checks}`);
}
console.log(`golden GREEN: ${real.checks} assertions; ${registry.length} HARD rule 양/음성 + exact tier/span`);
if (process.argv.includes("--selftest")) {
  const sources = Object.fromEntries(["classify.ts", "normalize.ts", "rules.ts", "index.ts"].map((f) => [f, readFileSync(join(SOURCE, f), "utf8")]));
  const mutants = [];
  const replace = (name, file, oldText, newText) => {
    assert.ok(sources[file].includes(oldText), `mutation anchor 없음: ${name}`);
    mutants.push({ name, file, code: sources[file].replace(oldText, newText) });
  };
  // 실제 rules.ts에서 규칙 하나씩 삭제. 골든셋과 baseline registry는 그대로 유지.
  for (const [name, terms] of [["HARD_LEGACY", core.HARD_LEGACY], ["HARD_NEW", core.HARD_NEW], ["THREAT_WORDS", core.THREAT_WORDS]]) {
    const declaration = new RegExp(`(export const ${name}[^=]*=\\s*\\[)([\\s\\S]*?)(\\];)`);
    const match = sources["rules.ts"].match(declaration);
    assert.ok(match, `사전 선언 없음: ${name}`);
    for (const rule of terms) {
      const literal = JSON.stringify(rule);
      assert.ok(match[2].includes(literal));
      const body = match[2].replace(literal + ",", "").replace(literal, "");
      mutants.push({ name: `delete-rule/${rule}`, file: "rules.ts", code: sources["rules.ts"].replace(declaration, () => match[1] + body + match[3]) });
    }
  }
  replace("delete-rule/새끼", "rules.ts", 'export const SAEKKI_RULE = "새끼";', 'export const SAEKKI_RULE = "";');
  replace("delete-rule/ㅗ", "rules.ts", 'export const JAMO_HARD_RE = /^[\\u1169]+$/;', 'export const JAMO_HARD_RE = /a^/;');
  replace("word-wide-allow", "classify.ts", 'span.start <= candidate.start && candidate.end <= span.end', 'true');
  replace("no-boundary", "classify.ts", 'return left && right;', 'return true;');
  replace("compatibility-jamo", "rules.ts", 'export const JAMO_HARD_RE = /^[\\u1169]+$/;', 'export const JAMO_HARD_RE = /^ㅗ+$/;');
  replace("no-elongation", "normalize.ts", '.replace(/([씨시])이+(?=발)/gu, "$1")', '');
  replace("threat-substring", "classify.ts", '!N(R.THREAT_FORMS[rule] ?? []).includes(norm)', '!norm.includes(normalizeToken(rule))');
  replace("whole-message-pass", "classify.ts", 'const words = splitWords(text);', 'if (text.includes("새끼손가락")) return { verdict: "pass", matches: [] };\n  const words = splitWords(text);');
  replace("positive-prefix-substring", "classify.ts", 'POSITIVE.includes(prev)', 'POSITIVE.some((p) => prev.includes(p))');
  const sandbox = mkdtempSync(join(process.env.OPENCLAW_REVIEW_ROOT || tmpdir(), "chat-profanity-mutants-"));
  let caught = 0;
  const survivors = [];
  try {
    for (let i = 0; i < mutants.length; i++) {
      const mutant = mutants[i];
      const dir = join(sandbox, String(i));
      mkdirSync(dir);
      for (const [file, code] of Object.entries(sources)) writeFileSync(join(dir, file), file === mutant.file ? mutant.code : code);
      // import 실패/크래시는 mutant 감지로 세지 않는다: 정상 로드 후 assertion RED여야 한다.
      const mod = await import(pathToFileURL(join(dir, "index.ts")).href);
      const result = runGate(mod.classify);
      if (result.failures.length) caught++;
      else survivors.push(mutant.name);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
  assert.deepEqual(survivors, [], `미감지 mutant: ${survivors.join(", ")}`);
  console.log(`selftest GREEN: ${caught}/${mutants.length} 실제 소스 mutant assertion RED, real GREEN`);
}
