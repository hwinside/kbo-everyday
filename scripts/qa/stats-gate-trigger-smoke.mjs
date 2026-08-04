/**
 * 게이트 **trigger 커버리지** 스모크.
 *
 * ── 배경(2026-08-04, 삼순 연속 지적 + 하린아빠 결정) ──
 * `stats-source-truth-gate.yml` 에 `paths`/`paths-ignore` 가 있으면, 거기 안 걸리는
 * 변경에서 workflow 가 통째 SKIP 되고 required check 는 "통과"로 보인다
 * — **trigger 자체가 false-green** 이다. 그래서 paths 를 제거했다(하린아빠 결정).
 * 이 스모크는 그 결정이 되돌려지지 않는지를 고정한다.
 *
 * ⚠︎ 직접 파싱은 두 번 뚫렸다(삼순 실증).
 *   1차: `^\s*paths:\s*$` 줄 정규식 → inline flow(`paths: ["docs/**"]`) 통과
 *   2차: 손으로 만든 들여쓰기 파서 → 6칸 indent(`      paths:`)와
 *        quoted key(`"paths":`) 변형 통과. 둘 다 **유효한 YAML** 이다.
 *
 * YAML 은 같은 의미를 표현하는 방법이 너무 많아서 자체 파서로는 못 닫는다.
 * 그래서 **실제 YAML parser** 로 읽는다. parser 를 쓸 수 없으면 SKIP 이 아니라 FAIL 이다
 * (검증 불가를 통과로 취급하면 게이트가 아니다).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const WORKFLOW = ".github/workflows/stats-source-truth-gate.yml";
const workflow = readFileSync(WORKFLOW, "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

/* ── 실제 YAML parser 로 읽는다 ──────────────────────────────────
 * `on` 은 YAML 1.1 에서 boolean true 로 파싱된다 — 그 함정까지 parser 가 처리한다. */
const parsed = await (async () => {
  const errors = [];

  // ① Node 생태계 parser 를 먼저 쓴다(런너 환경 의존이 가장 적다).
  for (const mod of ["yaml", "js-yaml"]) {
    try {
      const lib = await import(mod);
      const api = lib.default ?? lib;
      const doc = api.parse ? api.parse(workflow) : api.load(workflow);
      // YAML 1.1 에서 `on:` 은 boolean true 로 온다. 두 표기 모두 받는다.
      const on = doc?.on ?? doc?.[true] ?? doc?.["true"];
      if (on) return on;
      errors.push(`${mod}: on 블록을 찾지 못함`);
    } catch (error) {
      errors.push(`${mod}: ${error.message}`);
    }
  }

  // ② python3 + PyYAML 폴백.
  const script = [
    "import json, sys, yaml",
    'with open(sys.argv[1], encoding="utf-8") as f:',
    "    doc = yaml.safe_load(f)",
    'on = doc.get(True, doc.get("on"))',
    'print(json.dumps({"on": on}, default=str))',
  ].join("\n");
  try {
    const out = execFileSync("python3", ["-c", script, WORKFLOW], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out).on;
  } catch (error) {
    errors.push(`python3: ${error.message}`);
  }

  // ⚠︎ parser 를 못 쓰면 SKIP 이 아니라 FAIL 이다.
  // 검증 불가를 통과로 취급하면 이 게이트는 아무것도 검증하지 않는 것과 같다.
  throw new Error(
    `stats_gate_trigger_unparsable: workflow 를 YAML parser 로 읽지 못했다 — ${errors.join(" | ")}`,
  );
})();

assert.ok(parsed && typeof parsed === "object", "workflow 의 `on:` 블록을 파싱할 수 있어야 한다");

/* ── 1) paths/paths-ignore filter 가 없어야 한다(표기 무관) ──────── */
{
  const offenders = [];
  for (const [event, spec] of Object.entries(parsed)) {
    if (!spec || typeof spec !== "object") continue;
    for (const key of Object.keys(spec)) {
      if (/^paths(-ignore)?$/.test(key)) offenders.push(`${event}.${key}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "게이트에 paths/paths-ignore filter 가 있으면 거기 안 걸리는 변경에서 workflow 가 통째 SKIP 되고"
      + " required check 가 '통과'로 보인다(trigger false-green)."
      + ` 검출: ${offenders.join(", ")}`,
  );
}

/* ── 2) 두 이벤트가 모두 등록돼 있어야 한다 ────────────────────── */
{
  assert.ok("pull_request" in parsed, "pull_request 트리거가 있어야 한다");
  assert.ok("push" in parsed, "push 트리거가 있어야 한다");
  const branches = parsed.push?.branches;
  assert.ok(
    Array.isArray(branches) && branches.includes("main"),
    `push 는 main 브랜치를 대상으로 해야 한다 (actual: ${JSON.stringify(branches)})`,
  );
}

/* ── 3) 게이트가 부르는 npm script 가 실재해야 한다 ────────────── */
{
  const runSteps = [...workflow.matchAll(/run:\s*npm run ([a-z0-9:_-]+)/gi)].map((m) => m[1]);
  assert.ok(runSteps.length >= 3, `게이트가 npm script 를 실행해야 한다 (actual ${runSteps.length})`);
  for (const name of new Set(runSteps)) {
    assert.ok(pkg.scripts[name], `package.json 에 \`${name}\` script 가 없다 — 게이트가 죽은 스텝을 부른다`);
  }
}

console.log(
  `stats gate trigger smoke: ALL assertions PASS (no paths filter, events ${Object.keys(parsed).length})`,
);
