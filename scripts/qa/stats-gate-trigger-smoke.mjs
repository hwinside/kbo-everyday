/**
 * 게이트 **trigger 커버리지** 스모크.
 *
 * ── 배경(2026-08-04, 삼순 8차 + 하린아빠 결정) ──
 * 종전에는 `stats-source-truth-gate.yml` 이 `paths` allowlist 로 돌았다. 개별 나열이든
 * broad glob 이든, 거기 안 걸리는 새 의존이 생기면 workflow 가 통째 SKIP 되고 required
 * check 는 "통과"로 보인다 — **trigger 자체가 false-green** 이다. 실제로 이 트랙에서
 * `kbo-select.mjs` 를 새로 만들 때 나열을 손으로 추가해야 했다.
 *
 * 그래서 paths 를 **제거**했다(하린아빠 결정). 모든 PR / main push 에서 등록·실행한다.
 * 이 스모크는 그 결정이 되돌려지지 않는지를 고정한다.
 *
 * 계약:
 *  1) pull_request / push 어디에도 `paths` filter 가 없다(있으면 SKIP 경로가 생긴다).
 *  2) 두 이벤트가 모두 등록돼 있다(한쪽만 있으면 그 이벤트에서 게이트가 빠진다).
 *  3) 게이트가 실행하는 npm script 가 실제로 존재한다(죽은 스텝 호출 방지).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const WORKFLOW = ".github/workflows/stats-source-truth-gate.yml";
const workflow = readFileSync(WORKFLOW, "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

/* ── 1) paths filter 가 없어야 한다 ──────────────────────────── */
{
  const onStart = workflow.search(/^on:\s*$/m);
  assert.ok(onStart >= 0, "workflow 에 `on:` 블록이 있어야 한다");
  const jobsStart = workflow.indexOf("\njobs:");
  assert.ok(jobsStart > onStart, "workflow 에 `jobs:` 블록이 있어야 한다");

  const onBlock = workflow.slice(onStart, jobsStart);
  const pathsLines = onBlock
    .split("\n")
    .filter((line) => /^\s*paths(-ignore)?:\s*$/.test(line));

  assert.deepEqual(
    pathsLines,
    [],
    "게이트에 paths/paths-ignore filter 가 있으면 거기 안 걸리는 변경에서 workflow 가 통째 SKIP 되고"
      + " required check 가 '통과'로 보인다(trigger false-green). 모든 PR/main push 에서 실행해야 한다.",
  );
}

/* ── 2) 두 이벤트가 모두 등록돼 있어야 한다 ──────────────────── */
{
  const onStart = workflow.search(/^on:\s*$/m);
  const jobsStart = workflow.indexOf("\njobs:");
  const onBlock = workflow.slice(onStart, jobsStart);

  assert.ok(/^\s{2}pull_request:\s*$/m.test(onBlock), "pull_request 트리거가 있어야 한다");
  assert.ok(/^\s{2}push:\s*$/m.test(onBlock), "push 트리거가 있어야 한다");
  assert.ok(/^\s{6}-\s*main\s*$/m.test(onBlock), "push 는 main 브랜치를 대상으로 해야 한다");
}

/* ── 3) 게이트가 부르는 npm script 가 실재해야 한다 ──────────── */
{
  const runSteps = [...workflow.matchAll(/run:\s*npm run ([a-z0-9:_-]+)/gi)].map((m) => m[1]);
  assert.ok(runSteps.length >= 3, `게이트가 npm script 를 실행해야 한다 (actual ${runSteps.length})`);
  for (const name of new Set(runSteps)) {
    assert.ok(
      pkg.scripts[name],
      `package.json 에 \`${name}\` script 가 없다 — 게이트가 죽은 스텝을 부른다`,
    );
  }
  console.log(
    `stats gate trigger smoke: ALL assertions PASS (no paths filter, scripts ${new Set(runSteps).size})`,
  );
}
