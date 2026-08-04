/**
 * 게이트 **trigger 커버리지** 스모크.
 *
 * ── 배경(2026-08-04, 삼순) ──
 * `stats-source-truth-gate.yml` 은 `paths` allowlist 로 돈다. 여기 안 걸리면 workflow 가
 * 통째 SKIP 되고, required check 는 "통과"로 보인다 — **trigger 자체가 false-green** 이다.
 * 실제로 `kbo-select.mjs` 를 새로 만들 때 손으로 나열을 추가해야 했고, 잊었으면
 * 그 helper 만 고치는 PR 에서 게이트가 조용히 빠졌다.
 *
 * paths 를 아예 없애면 무관한 PR 마다 live KBO + Chromium 게이트가 돌아 외부 장애·비용이
 * 전체 개발을 막는다. 그래서 broad glob 으로 의존 뿌리를 잡되, **그 glob 이 실제 의존을
 * 전부 덮는지**를 여기서 기계적으로 검증한다. 손으로 관리하는 목록은 언젠가 반드시 샌다.
 *
 * 계약:
 *  1) 게이트가 실행하는 npm script 가 실제로 존재한다.
 *  2) 그 script 들이 타는 모든 로컬 모듈(전이 의존 포함)이 paths glob 에 걸린다.
 *  3) pull_request 와 push 의 paths 가 동일하다(한쪽만 고치면 그 이벤트에서 조용히 빠진다).
 *  4) glob 이 무관한 파일까지 덮지 않는다(그러면 paths 를 둔 의미가 없다).
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const WORKFLOW = ".github/workflows/stats-source-truth-gate.yml";
const workflow = readFileSync(WORKFLOW, "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

/* ── paths 블록 파싱 ─────────────────────────────────────────── */
function pathsBlocks(source) {
  const blocks = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*paths:\s*$/.test(lines[i])) continue;
    const entries = [];
    for (let j = i + 1; j < lines.length; j++) {
      const m = lines[j].match(/^\s*-\s*"([^"]+)"\s*$/);
      if (m) { entries.push(m[1]); continue; }
      if (/^\s*#/.test(lines[j]) || /^\s*$/.test(lines[j])) continue;
      break;
    }
    blocks.push(entries);
  }
  return blocks;
}

const blocks = pathsBlocks(workflow);
assert.equal(blocks.length, 2, `paths 블록은 pull_request/push 2개여야 한다 (actual ${blocks.length})`);
assert.deepEqual(
  blocks[0], blocks[1],
  "pull_request 와 push 의 paths 가 다르면 한쪽 이벤트에서 게이트가 조용히 빠진다",
);
const globs = blocks[0];

/** GitHub paths glob → 정규식 (`**` = 임의 깊이, `*` = 슬래시 제외). */
function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { out += ".*"; i++; }
      else out += "[^/]*";
    } else if (".+^${}()|[]\\".includes(c)) {
      out += "\\" + c;
    } else out += c;
  }
  return new RegExp(`^${out}$`);
}
const matchers = globs.map(globToRegExp);
const covered = (file) => matchers.some((re) => re.test(file));

/* ── 게이트가 실행하는 script → 진입 파일 ─────────────────────── */
const runSteps = [...workflow.matchAll(/run:\s*npm run ([a-z0-9:_-]+)/gi)].map((m) => m[1]);
assert.ok(runSteps.length >= 3, `게이트가 npm script 를 실행해야 한다 (actual ${runSteps.length})`);

const entries = new Set();
for (const name of runSteps) {
  const script = pkg.scripts[name];
  assert.ok(script, `package.json 에 \`${name}\` script 가 없다 — 게이트가 죽은 스텝을 부른다`);
  for (const m of script.matchAll(/(scripts\/[\w./-]+\.(?:mjs|ts|js))/g)) entries.add(m[1]);
}
assert.ok(entries.size > 0, "게이트 진입 파일을 찾지 못했다");

/* ── 전이 의존 수집(로컬 import 만) ───────────────────────────── */
function collectDeps(entry, seen = new Set()) {
  const file = resolve(entry);
  const rel = relative(process.cwd(), file);
  if (seen.has(rel) || !existsSync(file)) return seen;
  seen.add(rel);
  const source = readFileSync(file, "utf8");
  for (const m of source.matchAll(/from\s+"(\.[^"]+)"|import\("(\.[^"]+)"\)/g)) {
    const spec = m[1] ?? m[2];
    collectDeps(join(dirname(file), spec), seen);
  }
  return seen;
}

const deps = new Set();
for (const entry of entries) for (const d of collectDeps(entry)) deps.add(d);

const uncovered = [...deps].filter((f) => !covered(f));
assert.deepEqual(
  uncovered, [],
  `게이트가 타는 파일이 paths glob 에 안 걸린다 — 그 파일만 고치는 PR 에서 게이트가 SKIP 된다:\n  ${uncovered.join("\n  ")}`,
);

/* ── 데이터 산출물도 덮는가(수동 편집·data PR 오염 차단이 목적) ── */
for (const artifact of [
  "src/lib/constants/stats-2026-batters.json",
  "src/lib/constants/stats-2026-pitchers.json",
  "src/lib/constants/stats-2026-defense.json",
  "src/lib/constants/stats-2026-meta.json",
  "src/lib/constants/player-defense-runs.json",
  "src/lib/constants/players-roster.json",
  "src/lib/constants/foreign-id-map.ts",
  "package.json",
  WORKFLOW,
]) {
  assert.ok(covered(artifact), `데이터/설정 ${artifact} 가 paths 에 안 걸린다`);
}

/* ── 과잉 매칭 방지 — 무관한 파일까지 덮으면 paths 를 둔 의미가 없다 ── */
for (const unrelated of [
  "src/app/api/game-live/route.ts",
  "src/components/community/PostDetail.tsx",
  "supabase/migrations/20260804124500_x.sql",
  "docs/team-rules.md",
  ".github/workflows/update-roster-stats.yml",
]) {
  assert.ok(
    !covered(unrelated),
    `paths 가 무관한 ${unrelated} 까지 덮으면 모든 PR 에서 live KBO 게이트가 돈다`,
  );
}

console.log(
  `stats gate trigger smoke: ALL assertions PASS `
  + `(entry ${entries.size}, deps ${deps.size}, globs ${globs.length})`,
);
