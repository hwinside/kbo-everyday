#!/usr/bin/env node
/**
 * venue 게이트 **자기보호(trigger) 결속** 검사 — 삼순 R7 P1
 *
 * 왜 필요한가:
 *   required workflow 가 실행하는 QA 스크립트가 그 workflow 의 `paths` 에 없으면,
 *   **그 스크립트만 약화시키는 PR** 이 workflow 자체를 트리거하지 않고 머지된다.
 *   (`process.exit(0)` 추가나 assert 삭제 한 줄이면 게이트가 무력화되는데 check 는
 *   아예 안 돈다.) repo 에 branch protection/ruleset 이 없어 더 위험하다.
 *   실제로 신규 CLI 관제 게이트가 paths·lint 양쪽에서 누락돼 있었다(삼순 R7 지적).
 *
 * 무엇을 검사하나:
 *   1) workflow 가 `npm run qa:*` 로 실행하는 모든 스크립트의 **실제 파일 경로**를
 *      package.json 에서 역추적한다(스텝 문자열 하드코딩 아님).
 *   2) 그 파일들이 pull_request.paths / push.paths 에 **전부** 들어 있는지.
 *   3) lint 가능한 스크립트가 focused ESLint 대상에 들어 있는지.
 *
 * 판정 불가는 fail-close 한다(YAML 파서 부재·workflow 부재·스크립트 미정의).
 * 자체 YAML 파싱은 쓰지 않는다 — 8/4 스탯 게이트에서 자체 파서가 3회 뚫린 전례가 있다.
 */
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const WORKFLOW = join(REPO, ".github", "workflows", "venue-story-picker-gate.yml");
const PKG = join(REPO, "package.json");

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
  }
}

function loadYamlParser() {
  // 실제 YAML 파서를 쓴다. 부재 시 통과시키지 않고 fail-close.
  const require = createRequire(import.meta.url);
  for (const mod of ["yaml", "js-yaml"]) {
    try {
      const m = require(mod);
      if (mod === "yaml") return (s) => m.parse(s);
      return (s) => m.load(s);
    } catch {
      /* 다음 후보 */
    }
  }
  return null;
}

function run() {
  console.log("[TRIGGER] venue 게이트가 자기 QA 스크립트 변경에 반드시 트리거되는가");

  const parse = loadYamlParser();
  ok("TRIGGER: YAML 파서 사용 가능(부재면 검증 불가 → fail-close)", parse != null);
  if (!parse) {
    console.log(`\n결과: ${pass} pass / ${fail} fail`);
    process.exit(1);
  }

  ok("TRIGGER: workflow 파일 존재", existsSync(WORKFLOW));
  if (!existsSync(WORKFLOW)) {
    console.log(`\n결과: ${pass} pass / ${fail} fail`);
    process.exit(1);
  }

  const doc = parse(readFileSync(WORKFLOW, "utf8"));
  const pkg = JSON.parse(readFileSync(PKG, "utf8"));
  const scripts = pkg.scripts || {};

  // YAML 의 `on:` 은 파서에 따라 boolean true 로 키가 잡힌다.
  const on = doc?.on ?? doc?.[true];
  const prPaths = on?.pull_request?.paths;
  const pushPaths = on?.push?.paths;
  ok("TRIGGER: pull_request.paths 정의됨", Array.isArray(prPaths) && prPaths.length > 0);
  ok("TRIGGER: push.paths 정의됨", Array.isArray(pushPaths) && pushPaths.length > 0);
  if (!Array.isArray(prPaths) || !Array.isArray(pushPaths)) {
    console.log(`\n결과: ${pass} pass / ${fail} fail`);
    process.exit(1);
  }

  const steps = Object.values(doc.jobs || {}).flatMap((j) => j.steps || []);
  const runText = steps.map((s) => String(s.run || "")).join("\n");

  // ① workflow 가 실행하는 npm 스크립트 → 실제 파일 경로 역추적
  const npmScriptNames = [...runText.matchAll(/npm run ([a-z0-9:_-]+)/g)].map((m) => m[1]);
  ok(`TRIGGER: workflow 가 npm 스크립트를 실행 (실제 ${npmScriptNames.length}개)`, npmScriptNames.length > 0);

  const referenced = new Set();
  for (const name of npmScriptNames) {
    const body = scripts[name];
    ok(`TRIGGER: package.json 에 '${name}' 정의됨(미정의면 CI 가 즉시 깨짐)`, typeof body === "string");
    if (typeof body !== "string") continue;
    for (const m of body.matchAll(/(scripts\/[A-Za-z0-9_./-]+\.(?:mjs|ts|js|sh))/g)) {
      referenced.add(m[1]);
    }
  }
  ok(`TRIGGER: 실행 스크립트 파일을 역추적함 (실제 ${referenced.size}개)`, referenced.size > 0);

  // ② 역추적한 파일이 전부 paths 에 있는가 — 여기가 자기보호의 핵심
  const missingPr = [];
  const missingPush = [];
  for (const file of referenced) {
    if (!existsSync(join(REPO, file))) continue; // 다른 워크플로 소유이거나 삭제된 경로는 건너뜀
    if (!prPaths.includes(file)) missingPr.push(file);
    if (!pushPaths.includes(file)) missingPush.push(file);
  }
  ok(
    `TRIGGER: 실행되는 모든 QA 스크립트가 pull_request.paths 에 있음 (누락 ${missingPr.length}${missingPr.length ? ": " + missingPr.join(", ") : ""})`,
    missingPr.length === 0,
  );
  ok(
    `TRIGGER: 실행되는 모든 QA 스크립트가 push.paths 에 있음 (누락 ${missingPush.length}${missingPush.length ? ": " + missingPush.join(", ") : ""})`,
    missingPush.length === 0,
  );

  // ③ lint 가능한 스크립트(.ts/.mjs/.js)는 focused ESLint 대상이어야 한다
  const lintSteps = steps.filter((s) => /\beslint\b/.test(String(s.run || "")));
  ok("TRIGGER: focused ESLint 스텝 존재", lintSteps.length > 0);
  const lintText = lintSteps.map((s) => String(s.run || "")).join("\n");
  const missingLint = [...referenced].filter(
    (f) => /\.(ts|mjs|js)$/.test(f) && existsSync(join(REPO, f)) && !lintText.includes(f),
  );
  ok(
    `TRIGGER: 실행 스크립트가 focused ESLint 대상에 포함 (누락 ${missingLint.length}${missingLint.length ? ": " + missingLint.join(", ") : ""})`,
    missingLint.length === 0,
  );

  // ④ workflow 자기 자신과 package.json 도 트리거에 있어야 한다
  //    (스텝을 지우거나 스크립트 본문을 바꾸는 변경이 게이트를 우회하면 안 된다)
  for (const self of [".github/workflows/venue-story-picker-gate.yml", "package.json"]) {
    ok(`TRIGGER: '${self}' 가 pull_request.paths 에 있음`, prPaths.includes(self));
    ok(`TRIGGER: '${self}' 가 push.paths 에 있음`, pushPaths.includes(self));
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

run();
