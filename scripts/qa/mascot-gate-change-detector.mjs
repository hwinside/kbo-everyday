#!/usr/bin/env node
/**
 * mascot 게이트 semantic change-detector (PR #1254, 삼순 NO-GO 1·2차 반영)
 *
 * 문제: 워크플로 트리거 paths에 package.json이 있으면 무관 PR마다 풀 게이트(40~73분+)가
 * 돌고, 빼면 package.json만 고쳐 mascot 게이트 script를 무력화하는 변경이 GREEN으로
 * 통과한다. 해법: 트리거는 유지하되 여기서 semantic 판정으로 job별 실행 여부를 가른다.
 *
 * 2차 NO-GO 반영:
 *  - run_motion / run_source 분리: 53분짜리 source job(원본 provision·재현·mutations:full)은
 *    원본·빌더·ledger 영향 변경일 때만 돈다. component/render/motion 변경은 motion만.
 *  - 이 파일이 trigger path 분류의 SSOT: selftest가 워크플로 trigger paths를 읽어
 *    분류 불가(누락) 경로가 하나라도 있으면 RED — NON_PKG 하드코딩 누락 사고 재발 방지.
 *
 * 분류(경로 → 실행 job):
 *  - motion-only: UI 컴포넌트·매핑 상수·render/visual/motion 게이트 스크립트
 *  - source(둘 다 실행): 파생 자산·빌더·SOURCES ledger·source mutate — 자산 파이프라인
 *    변경은 픽셀 무결성(motion)에도 영향하므로 both
 *  - both: 두 job이 함께 쓰는 스크립트·detector 자신·워크플로 자신
 *  - package.json: semantic 판정(아래) — 관련이면 both, 무관이면 둘 다 skip
 *  - 분류 불가: fail-closed(both)  ← 단 selftest가 트리거 경로의 분류 불가를 RED로 잡으므로
 *    실제로는 "새 트리거 경로를 분류에 안 넣으면 머지 전에 RED"가 계약이다.
 *
 * package.json의 mascot 관련 표면(semantic view):
 *  - scripts 중 key에 mascot이 들어가는 항목: key+value 전체
 *  - 그 외 scripts(prebuild 등): value 안의 mascot 토큰 multiset만
 *    → prebuild에 무관 게이트를 추가해도 skip, mascot 게이트를 빼면 heavy
 *  - dependencies/devDependencies 중 key에 playwright가 들어가는 항목
 *
 * 사용:
 *  --decide --changed <changed-files.txt> --base-pkg <base-package.json> --head-pkg <package.json>
 *      → stdout에 GITHUB_OUTPUT 형식 두 줄: run_motion=true|false / run_source=true|false
 *        판정 불능이면 둘 다 true(fail-closed).
 *  --selftest [--workflow <yml>]
 *      → ①trigger↔분류 결속(누락 시 RED) ②관련/무관 fixture. 실패 시 exit 1.
 */

import { readFileSync } from "node:fs";

// ── 경로 분류 SSOT ─────────────────────────────────────────────────
const MOTION_ONLY = [
  "src/components/dm/GeniusMascotImage.tsx",
  "src/lib/constants/baseball-genius.ts",
  "scripts/qa/genius-mascot-render-gate.mjs",
  "scripts/qa/genius-mascot-visual-qa.mjs",
  "scripts/qa/genius-mascot-motion.ts",
  "scripts/qa/genius-mascot-motion-mutations.mjs",
];
const SOURCE_IMPACT = [ // 원본·빌더·ledger — source 포함 둘 다 실행
  "public/mascot/motion/",
  "scripts/assets/build-mascot-motion.py",
  "scripts/assets/mascot-motion-SOURCES.sha256",
  "scripts/qa/mascot-source-mutate.py",
];
const BOTH_SHARED = [
  "scripts/ci/prebuild-gates.mjs", // prebuild 게이트 러너 — GATES 목록 변경은 fail-closed로 둘 다 실행
  "scripts/qa/genius-mascot-asset-mutations.mjs",
  "scripts/qa/mascot-gate-change-detector.mjs",
  ".github/workflows/genius-mascot-motion-gate.yml",
];

/** 경로 1개 분류: "motion" | "source" | "both" | null(분류 불가) */
export function classifyPath(path) {
  const norm = String(path).replace(/^\.\//, "");
  if (SOURCE_IMPACT.some((p) => (p.endsWith("/") ? norm.startsWith(p) : norm === p))) return "source";
  if (MOTION_ONLY.includes(norm)) return "motion";
  if (BOTH_SHARED.includes(norm)) return "both";
  if (norm === "package.json") return "package"; // semantic 판정으로 위임
  return null;
}

// ── package.json semantic view ─────────────────────────────────────
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

export function packageRelevant(basePkg, headPkg) {
  return JSON.stringify(mascotView(basePkg)) !== JSON.stringify(mascotView(headPkg));
}

// ── 종합 판정 ──────────────────────────────────────────────────────
/** changedFiles: 변경 경로 배열. basePkg/headPkg: 파싱된 package.json(없으면 null). */
export function decideRun(changedFiles, basePkg, headPkg) {
  let motion = false;
  let source = false;
  for (const f of changedFiles) {
    if (!f.trim()) continue;
    const cls = classifyPath(f.trim());
    if (cls === "motion") motion = true;
    else if (cls === "source" || cls === "both") { motion = true; source = true; }
    else if (cls === "package") {
      if (!basePkg || !headPkg || packageRelevant(basePkg, headPkg)) { motion = true; source = true; }
    }
    // cls === null: 트리거 밖 경로(무관 파일) — 실행 사유 아님.
    // 단 트리거 paths에 있는데 분류 안 되는 경로는 selftest가 머지 전에 RED로 잡는다.
  }
  return { run_motion: motion, run_source: source };
}

// ── selftest ───────────────────────────────────────────────────────
export function extractTriggerPaths(workflowText) {
  // `paths: &gate_paths` 앵커 블록의 - "..." 항목 추출
  const m = workflowText.match(/paths: &gate_paths\n((?:\s+- "[^"]+"\n)+)/);
  if (!m) return null;
  return [...m[1].matchAll(/- "([^"]+)"/g)].map((x) => x[1]);
}

function normalizeTriggerPath(p) {
  return p.replace(/\/\*\*$/, "/"); // glob → prefix 표기로 정규화
}

/** 분류 SSOT가 기대하는 전체 경로 set (정규화 표기) */
export function ssotPaths() {
  return [...MOTION_ONLY, ...SOURCE_IMPACT, ...BOTH_SHARED, "package.json"];
}

/** 삼순 #1254 3차 blocker: 단방향(trigger ⊆ 분류)만 검사하면 workflow에서 trigger를
 *  삭제해도 GREEN → 정규화한 양쪽 경로 set equality를 검사한다.
 *  반환: 오류 문자열 배열(빈 배열 = 결속 정상). */
export function checkTriggerBinding(workflowText) {
  const trig = extractTriggerPaths(workflowText);
  if (!trig || trig.length === 0) return ["trigger paths 추출 실패"];
  const errors = [];
  const normTrig = trig.map(normalizeTriggerPath);
  const trigSet = new Set(normTrig);
  const ssotSet = new Set(ssotPaths());
  for (const p of normTrig) {
    if (!ssotSet.has(p)) errors.push(`trigger에 있으나 분류 SSOT에 없음: ${p}`);
  }
  for (const p of ssotSet) {
    if (!trigSet.has(p)) errors.push(`분류 SSOT에 있으나 trigger에서 누락: ${p}`);
  }
  return errors;
}

function selftest(workflowPath) {
  let fail = 0;
  const check = (name, ok, detail) => {
    if (!ok) fail += 1;
    console.log(`  ${ok ? "✅" : "❌ SELFTEST-FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  // ① trigger ↔ 분류 SSOT 양방향 set equality (어느 쪽 누락이든 RED)
  let wfText = null;
  try {
    wfText = readFileSync(workflowPath, "utf8");
  } catch { /* fall through */ }
  check("T0 workflow 읽기", wfText !== null, workflowPath);
  const bindErrors = wfText ? checkTriggerBinding(wfText) : ["workflow 없음"];
  check("T1 trigger ↔ 분류 SSOT set equality", bindErrors.length === 0, bindErrors.join(" / "));
  // 미지 경로는 분류 불가(null)여야 결속 검사가 의미를 가진다(항상 non-null이면 결속이 공허)
  check("T2 미지 경로는 분류 불가", classifyPath("src/some/unknown-file.ts") === null);

  // ①' 결속 검사 검출력 mutant: workflow fixture에서 trigger 한 줄 삭제 → 반드시 RED
  if (wfText) {
    const wfMutants = [
      ["T-M1 trigger 삭제(public/mascot/motion/**)", wfText.replace(/[^\S\n]*- "public\/mascot\/motion\/\*\*"\n/, "")],
      ["T-M2 trigger 삭제(GeniusMascotImage.tsx)", wfText.replace(/[^\S\n]*- "src\/components\/dm\/GeniusMascotImage\.tsx"\n/, "")],
    ];
    for (const [name, mutated] of wfMutants) {
      const changedActually = mutated !== wfText;
      const red = changedActually && checkTriggerBinding(mutated).length > 0;
      check(`${name} → RED 검출`, red, changedActually ? "삭제했는데 GREEN — 결속 검사 무력" : "mutant가 원본을 못 바꿈(정규식 확인)");
    }
  }

  // ② run_motion/run_source fixture
  const basePkg = {
    scripts: {
      "qa:genius-mascot-visual": "tsx scripts/qa/genius-mascot-visual-qa.mjs",
      "qa:genius-mascot-assets:mutations:full": "node scripts/qa/genius-mascot-asset-mutations.mjs --full",
      prebuild: "npm run qa:genius-mascot-motion && npm run qa:other-gate",
      build: "next build",
    },
    devDependencies: { playwright: "1.46.0", tsx: "4.0.0" },
  };
  const clone = () => JSON.parse(JSON.stringify(basePkg));
  const fx = (name, changed, headPkg, expM, expS) => {
    const { run_motion, run_source } = decideRun(changed, basePkg, headPkg ?? basePkg);
    check(`F ${name}`, run_motion === expM && run_source === expS, `got motion=${run_motion} source=${run_source} (기대 ${expM}/${expS})`);
  };
  // component-only → motion true / source false
  fx("component-only(GeniusMascotImage)", ["src/components/dm/GeniusMascotImage.tsx"], null, true, false);
  fx("component-only(baseball-genius 상수)", ["src/lib/constants/baseball-genius.ts"], null, true, false);
  fx("motion 게이트 스크립트", ["scripts/qa/genius-mascot-visual-qa.mjs"], null, true, false);
  // source-path → 둘 다 true
  fx("source-path(빌더)", ["scripts/assets/build-mascot-motion.py"], null, true, true);
  fx("source-path(ledger)", ["scripts/assets/mascot-motion-SOURCES.sha256"], null, true, true);
  fx("source-path(파생 자산)", ["public/mascot/motion/swing.webp"], null, true, true);
  // 공용 → 둘 다 true
  fx("공용(asset-mutations)", ["scripts/qa/genius-mascot-asset-mutations.mjs"], null, true, true);
  fx("공용(워크플로 자신)", [".github/workflows/genius-mascot-motion-gate.yml"], null, true, true);
  // 무관 package-only → 둘 다 false
  fx("무관 package(무관 script 추가)", ["package.json"], (() => { const p = clone(); p.scripts["qa:client-dedupe"] = "tsx x.ts"; return p; })(), false, false);
  fx("무관 package(prebuild 무관 추가)", ["package.json"], (() => { const p = clone(); p.scripts.prebuild += " && npm run qa:client-dedupe"; return p; })(), false, false);
  fx("무관 package(무관 dep)", ["package.json"], (() => { const p = clone(); p.devDependencies.lodash = "4"; return p; })(), false, false);
  // 관련 package → 둘 다 true (fail-closed)
  fx("관련 package(mascot script 무력화)", ["package.json"], (() => { const p = clone(); p.scripts["qa:genius-mascot-assets:mutations:full"] = "true"; return p; })(), true, true);
  fx("관련 package(mascot script 삭제)", ["package.json"], (() => { const p = clone(); delete p.scripts["qa:genius-mascot-visual"]; return p; })(), true, true);
  fx("관련 package(prebuild에서 mascot 제거)", ["package.json"], (() => { const p = clone(); p.scripts.prebuild = "npm run qa:other-gate"; return p; })(), true, true);
  fx("관련 package(playwright 범프)", ["package.json"], (() => { const p = clone(); p.devDependencies.playwright = "1.99.0"; return p; })(), true, true);
  // package 파싱 불능(base/head 미확보) → fail-closed 둘 다 true — fx의 basePkg fallback을
  // 타면 공허해지므로 decideRun을 직접 호출한다.
  {
    const r = decideRun(["package.json"], null, null);
    check("F package 판정 불능 fail-closed", r.run_motion === true && r.run_source === true, `got motion=${r.run_motion} source=${r.run_source}`);
  }
  // 혼합: 무관 package + component → motion만
  fx("혼합(무관 package + component)", ["package.json", "src/components/dm/GeniusMascotImage.tsx"],
    (() => { const p = clone(); p.scripts["qa:foo"] = "echo"; return p; })(), true, false);
  // rename-away: --no-renames 전제 — 구 경로가 D로, 새 경로가 A로 둘 다 나타난다.
  // 구 경로(D)가 목록에 있으므로 게이트가 반드시 돈다(rename으로 감시 대상을 옮겨도 skip 불가).
  fx("rename-away(component 구경로 D+새경로 A)", ["src/components/dm/GeniusMascotImage.tsx", "src/components/dm/RenamedMascot.tsx"], null, true, false);
  fx("rename-away(ledger 구경로 D+새경로 A)", ["scripts/assets/mascot-motion-SOURCES.sha256", "scripts/assets/renamed-ledger.sha256"], null, true, true);

  console.log(`SELFTEST: ${fail === 0 ? "GREEN" : "RED"}`);
  if (fail > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────
function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    selftest(arg("--workflow") ?? ".github/workflows/genius-mascot-motion-gate.yml");
    return;
  }
  if (argv.includes("--decide")) {
    try {
      const changed = readFileSync(arg("--changed"), "utf8").split("\n").filter(Boolean);
      let basePkg = null;
      let headPkg = null;
      if (changed.some((f) => f.trim() === "package.json")) {
        basePkg = JSON.parse(readFileSync(arg("--base-pkg"), "utf8"));
        headPkg = JSON.parse(readFileSync(arg("--head-pkg"), "utf8"));
      }
      const { run_motion, run_source } = decideRun(changed, basePkg, headPkg);
      console.log(`run_motion=${run_motion}`);
      console.log(`run_source=${run_source}`);
    } catch (e) {
      // 판정 불능 = fail-closed: 둘 다 돌린다
      console.error(`detector error (fail-closed → both): ${e.message}`);
      console.log("run_motion=true");
      console.log("run_source=true");
    }
    return;
  }
  console.error("usage: --decide --changed <file> --base-pkg <p> --head-pkg <p> | --selftest [--workflow <yml>]");
  process.exit(2);
}

main();
