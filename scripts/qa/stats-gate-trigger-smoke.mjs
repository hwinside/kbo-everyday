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

/* ── workflow 를 실제로 파싱한다 ─────────────────────────────────
 *
 * ⚠︎ 직전 판은 `^\\s*paths:\\s*$` 같은 줄 단위 정규식이라 **블록형만** 잡았다.
 * 그래서 inline flow 문법(`paths: ["docs/**"]`, `paths-ignore: ["scripts/lib/**"]`)을
 * 넣으면 게이트가 GREEN 이었다(삼순 실증, merged main 에서도 재현 확인).
 * YAML 은 같은 의미를 여러 문법으로 쓸 수 있으므로 문자열 검사로는 닫을 수 없다.
 * 구조를 읽는다. */
const onSection = (() => {
  const lines = workflow.split("\n");
  const start = lines.findIndex((l) => /^on:\s*$/.test(l));
  assert.ok(start >= 0, "workflow 에 `on:` 블록이 있어야 한다");
  const events = {};
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // 다음 top-level 키(jobs: 등)
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;
    const top = line.match(/^ {2}([A-Za-z_]+):\s*(.*)$/);
    if (top) {
      current = top[1];
      events[current] = { inline: top[2].trim(), keys: [] };
      continue;
    }
    const sub = line.match(/^ {4}([A-Za-z_-]+):\s*(.*)$/);
    if (sub && current) events[current].keys.push({ key: sub[1], value: sub[2].trim() });
  }
  return events;
})();

/* ── 1) paths/paths-ignore filter 가 없어야 한다(문법 무관) ──────── */
{
  const offenders = [];
  for (const [event, spec] of Object.entries(onSection)) {
    for (const { key } of spec.keys) {
      if (/^paths(-ignore)?$/.test(key)) offenders.push(`${event}.${key}`);
    }
    if (/paths(-ignore)?\s*:/.test(spec.inline)) offenders.push(`${event}(inline)`);
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
  assert.ok(onSection.pull_request, "pull_request 트리거가 있어야 한다");
  assert.ok(onSection.push, "push 트리거가 있어야 한다");
  const branches = onSection.push.keys.find((k) => k.key === "branches");
  assert.ok(branches, "push 에 branches 지정이 있어야 한다");
  assert.ok(
    /main/.test(branches.value) || /^\s{6}-\s*main\s*$/m.test(workflow),
    "push 는 main 브랜치를 대상으로 해야 한다",
  );
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
