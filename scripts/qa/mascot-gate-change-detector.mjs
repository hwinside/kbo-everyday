#!/usr/bin/env node
/**
 * mascot 게이트 semantic change-detector (PR #1254, 삼순 NO-GO 반영)
 *
 * 문제: 워크플로 트리거 paths에 package.json이 있으면 무관 PR마다 풀 게이트(40~73분+)가
 * 돌고, 빼면 package.json만 고쳐 mascot 게이트 script를 무력화하는 변경이 GREEN으로
 * 통과한다. 해법: 트리거는 유지하되, package.json의 **mascot 관련 표면**이 실제로
 * 바뀌었을 때만 heavy job을 돌리고 무관 변경은 성공-skip 한다.
 *
 * mascot 관련 표면(semantic view):
 *  - scripts 중 key에 mascot이 들어가는 항목: key+value 전체
 *  - 그 외 scripts(prebuild 등): value 안의 mascot 토큰 multiset만
 *    → prebuild에 무관 게이트를 추가해도 skip, mascot 게이트를 빼면 heavy
 *  - dependencies/devDependencies 중 key에 playwright가 들어가는 항목
 *    (heavy job의 브라우저 렌더 축이 playwright 버전에 결속)
 *
 * 사용:
 *  node mascot-gate-change-detector.mjs <base-package.json> <head-package.json>
 *    → stdout에 "heavy" 또는 "skip" (exit 0). 파싱 불가 등 판정 불능이면 "heavy"
 *      (fail-closed: 모르면 돌린다).
 *  node mascot-gate-change-detector.mjs --selftest
 *    → 관련/무관 fixture로 검출력 증명. 실패 시 exit 1.
 */

import { readFileSync } from "node:fs";

export function mascotView(pkg) {
  const view = { scripts: {}, playwright: {} };
  const scripts = pkg?.scripts ?? {};
  for (const [key, value] of Object.entries(scripts)) {
    const v = String(value);
    if (/mascot/i.test(key)) {
      view.scripts[key] = v; // mascot 명명 script는 전체 결속
    } else {
      const tokens = (v.match(/\S*mascot\S*/gi) ?? []).sort();
      if (tokens.length > 0) view.scripts[key] = tokens; // 값 속 mascot 토큰만 결속
    }
  }
  for (const depsKey of ["dependencies", "devDependencies"]) {
    for (const [key, value] of Object.entries(pkg?.[depsKey] ?? {})) {
      if (/playwright/i.test(key)) view.playwright[`${depsKey}.${key}`] = String(value);
    }
  }
  return view;
}

export function decide(basePkg, headPkg) {
  const base = JSON.stringify(mascotView(basePkg));
  const head = JSON.stringify(mascotView(headPkg));
  return base === head ? "skip" : "heavy";
}

function selftest() {
  const base = {
    scripts: {
      "qa:genius-mascot-visual": "tsx scripts/qa/genius-mascot-visual-qa.mjs",
      "qa:genius-mascot-assets:mutations:full": "node scripts/qa/genius-mascot-asset-mutations.mjs --full",
      prebuild: "npm run qa:genius-mascot-motion && npm run qa:other-gate",
      build: "next build",
    },
    devDependencies: { playwright: "1.46.0", tsx: "4.0.0" },
  };
  const clone = () => JSON.parse(JSON.stringify(base));
  const cases = [
    // ── 관련(heavy여야 함) ──
    ["mascot script 값을 true로 무력화", (() => { const p = clone(); p.scripts["qa:genius-mascot-assets:mutations:full"] = "true"; return p; })(), "heavy"],
    ["mascot script 삭제", (() => { const p = clone(); delete p.scripts["qa:genius-mascot-visual"]; return p; })(), "heavy"],
    ["prebuild에서 mascot 게이트 제거", (() => { const p = clone(); p.scripts.prebuild = "npm run qa:other-gate"; return p; })(), "heavy"],
    ["mascot script 신설", (() => { const p = clone(); p.scripts["qa:genius-mascot-new"] = "echo hi"; return p; })(), "heavy"],
    ["playwright 버전 변경", (() => { const p = clone(); p.devDependencies.playwright = "1.99.0"; return p; })(), "heavy"],
    // ── 무관(skip이어야 함) ──
    ["무관 script 추가", (() => { const p = clone(); p.scripts["qa:client-dedupe"] = "tsx scripts/qa/client-dedupe-gate.ts"; return p; })(), "skip"],
    ["prebuild에 무관 게이트 추가", (() => { const p = clone(); p.scripts.prebuild += " && npm run qa:client-dedupe"; return p; })(), "skip"],
    ["무관 dependency 추가", (() => { const p = clone(); p.devDependencies.lodash = "4.0.0"; return p; })(), "skip"],
    ["무관 script 값 변경", (() => { const p = clone(); p.scripts.build = "next build --turbo"; return p; })(), "skip"],
    ["동일 내용", clone(), "skip"],
  ];
  let fail = 0;
  for (const [name, head, expected] of cases) {
    const got = decide(base, head);
    const ok = got === expected;
    if (!ok) fail += 1;
    console.log(`  ${ok ? "✅" : "❌ SELFTEST-FAIL"} ${name} → ${got} (기대 ${expected})`);
  }
  console.log(`SELFTEST: ${fail === 0 ? "GREEN" : "RED"}`);
  if (fail > 0) process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) {
    selftest();
    return;
  }
  const [basePath, headPath] = args;
  if (!basePath || !headPath) {
    console.error("usage: mascot-gate-change-detector.mjs <base-package.json> <head-package.json> | --selftest");
    process.exit(2);
  }
  try {
    const basePkg = JSON.parse(readFileSync(basePath, "utf8"));
    const headPkg = JSON.parse(readFileSync(headPath, "utf8"));
    console.log(decide(basePkg, headPkg));
  } catch (e) {
    // 판정 불능 = fail-closed: heavy로 돌린다
    console.error(`detector error (fail-closed → heavy): ${e.message}`);
    console.log("heavy");
  }
}

main();
