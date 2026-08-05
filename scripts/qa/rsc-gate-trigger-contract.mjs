#!/usr/bin/env node
/**
 * result-tone-gate workflow 가 홈 `_rsc` 예산 게이트를 **실제로 트리거하는지** 잠근다.
 *
 * 배경 (삼순 NO-GO 3차 지적②, 2026-08-05):
 * 게이트를 required workflow 에 얹어도, workflow `paths` 가 홈 렌더 트리를 안 덮으면
 * 신규 홈 `<Link>` 를 추가하는 PR 에서 workflow 가 아예 안 돈다(= 게이트 우회).
 * 개별 파일 목록만으로는 새 파일이 추가되면 트리거되지 않는다.
 *
 * 이 게이트가 잠그는 계약:
 *   ① pull_request.paths 와 push.paths 가 홈 렌더 트리 필수 glob 을 모두 포함한다.
 *   ② budget 게이트 스크립트 자신과 이 트리거 게이트 자신도 paths 에 포함된다
 *      (게이트를 고치는 PR 에서 게이트가 안 도는 사각을 막는다).
 *   ③ workflow 가 budget 게이트를 `node scripts/qa/rsc-prefetch-budget-gate.mjs` 로
 *      **직접 호출**한다(npm alias 우회 decoy 차단, 지적 2차의 결속을 회귀 방지).
 *
 * env·브라우저 무의존. `--selftest` 는 결함 주입 RED.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "../..");
const WF = path.join(ROOT, ".github/workflows/result-tone-gate.yml");

/** 홈 초기 렌더 트리에서 `<Link>` prefetch 가 사는 영역. 신규 파일까지 덮도록 glob 포함. */
const REQUIRED_PATHS = [
  "src/components/home/**",
  "src/app/(main)/page.tsx",
  "src/app/(main)/layout.tsx",
  "src/components/ui/TabBar.tsx",
  "src/components/ui/HeaderProfileLink.tsx",
  "src/components/game/CompactGameCard.tsx",
  "scripts/qa/rsc-prefetch-budget-gate.mjs",
  "scripts/qa/rsc-gate-trigger-contract.mjs",
];

const DIRECT_CALL = "node scripts/qa/rsc-prefetch-budget-gate.mjs";
const BASELINE_EXACT = "node scripts/qa/rsc-prefetch-budget-gate.mjs --require-browser";
const ALIAS_CALL = "npm run qa:rsc-prefetch-budget";

/** required job 에서 budget 게이트를 실행하는 named step. 이 step 하나만 검사한다. */
const BASELINE_STEP_NAME = "Run _rsc prefetch budget gate (fail-closed)";

function loadWorkflow(text) {
  const doc = yaml.load(text);
  const on = doc.on ?? doc[true]; // 'on' 이 YAML 에서 boolean true 로 파싱될 수 있다
  const pr = on?.pull_request?.paths ?? [];
  const push = on?.push?.paths ?? [];
  const steps = doc.jobs?.["result-tone"]?.steps ?? [];
  const baselineStep = steps.find((s) => s.name === BASELINE_STEP_NAME) ?? null;
  return { pr, push, baselineStep };
}

function check(text) {
  const { pr, push, baselineStep } = loadWorkflow(text);
  const fails = [];
  const pass = [];

  for (const req of REQUIRED_PATHS) {
    const inPr = pr.includes(req);
    const inPush = push.includes(req);
    if (inPr && inPush) pass.push(`paths 포함: ${req}`);
    else fails.push(`paths 누락: ${req} (pr=${inPr}, push=${inPush}) — 이 파일 변경 시 게이트가 안 돈다`);
  }

  // ⚠️ 전체 step 을 join 해서 검색하면 baseline-only alias swap 을 놓친다(삼순 NO-GO 4차 지적②):
  // mutation step 에 직접 호출이 남아 있어서 GREEN 이 된다. named baseline step 만 지목한다.
  if (!baselineStep) {
    fails.push(`named step "${BASELINE_STEP_NAME}" 을 찾을 수 없다 — 이름이 바뀌면 검사 대상이 사라진다`);
  } else {
    const run = baselineStep.run ?? "";
    // includes 로 검사하면 `... || true` 나 뒤에 붙인 no-op 에 뚫린다(삼순 NO-GO 5차 지적①).
    // 실행 라인(주석 #·빈줄 제외)이 정확히 그 단일 명령 하나여야 한다.
    const execLines = run.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    if (execLines.length === 1 && execLines[0] === BASELINE_EXACT)
      pass.push(`baseline step 이 정확히 단일 명령: "${BASELINE_EXACT}"`);
    else
      fails.push(`baseline step 실행 라인이 정확히 "${BASELINE_EXACT}" 하나가 아니다 (실제: ${JSON.stringify(execLines)}) — || true·no-op 접미사에 뚫릴 수 있다`);
  }

  return { fails, pass };
}

function run(label, text) {
  const { fails, pass } = check(text);
  for (const p of pass) console.log(`  PASS ${p}`);
  for (const f of fails) console.log(`  FAIL ${f}`);
  console.log(`${label}: PASS ${pass.length} / FAIL ${fails.length}`);
  return fails.length;
}

const text = readFileSync(WF, "utf8");

if (process.argv.includes("--selftest")) {
  let bad = 0;
  const cases = [
    ["A. home glob 제거", (t) => t.replace(/^\s*- "src\/components\/home\/\*\*"\n/gm, "")],
    ["B. 모든 호출을 npm alias 로 되돌림", (t) =>
      t.replace(/node scripts\/qa\/rsc-prefetch-budget-gate\.mjs --require-browser/g,
                "npm run qa:rsc-prefetch-budget:required")],
    ["B3. baseline step 에 `|| true` 접미사(includes 검사면 놓친다)", (t) => {
      const lines = t.split("\n");
      let inBaseline = false;
      return lines.map((ln) => {
        if (ln.includes("- name: Run _rsc prefetch budget gate (fail-closed)")) inBaseline = true;
        else if (/^\s*- name:/.test(ln)) inBaseline = false;
        if (inBaseline && ln.trim() === "run: node scripts/qa/rsc-prefetch-budget-gate.mjs --require-browser")
          return ln + " || true";
        return ln;
      }).join("\n");
    }],
    ["B2. baseline step 만 npm alias 로 되돌림(전체 join 검색이면 놓친다)", (t) => {
      // named baseline step 의 run 라인만 alias 로 교체. mutation step 은 그대로 둔다.
      const lines = t.split("\n");
      let inBaseline = false;
      return lines.map((ln) => {
        if (ln.includes("- name: Run _rsc prefetch budget gate (fail-closed)")) inBaseline = true;
        else if (/^\s*- name:/.test(ln)) inBaseline = false;
        if (inBaseline && ln.includes("node scripts/qa/rsc-prefetch-budget-gate.mjs --require-browser"))
          return ln.replace("node scripts/qa/rsc-prefetch-budget-gate.mjs --require-browser",
                            "npm run qa:rsc-prefetch-budget:required");
        return ln;
      }).join("\n");
    }],
    ["C. 트리거 게이트 자기 자신 paths 제거", (t) =>
      t.replace(/^\s*- "scripts\/qa\/rsc-gate-trigger-contract\.mjs"\n/gm, "")],
  ];
  for (const [name, mut] of cases) {
    console.log(`\n--- selftest ${name} ---`);
    const n = run("mutation", mut(text));
    if (n === 0) { console.log("  ❌ RED 를 못 만들었다 — 검증력 없음"); bad++; }
    else console.log(`  ✅ RED (FAIL ${n})`);
  }
  console.log(`\nselftest 결과: 검증력 없는 mutation ${bad}건`);
  process.exit(bad === 0 ? 0 : 1);
}

console.log("=== rsc 게이트 트리거 계약 ===");
process.exit(run("baseline", text) === 0 ? 0 : 1);
