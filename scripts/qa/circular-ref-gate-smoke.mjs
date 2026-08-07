/**
 * 순환참조 메타게이트(축②) 스모크.
 *
 * §1 검출기 검출력(합성 fixture, 결함주입 포함)
 * §2 게이트 실행 경로 — 실제 위반 파일을 임시 생성해 게이트가 RED 를 내는지
 * §3 registry ↔ 크롤러 write 경로 동기(레지스트리 SSOT 드리프트 감지)
 * §4 prebuild 필수 체인 편입 pin(orphan 방지 — #1120·축③ 교훈)
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { detectCircularRefs } from "../ci/lib/circular-ref-detect.mjs";
import { CRAWL_MANAGED_FILES, matchManagedFile } from "../ci/lib/crawl-managed-registry.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let pass = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (e) {
    console.error(`  ✗ ${name}\n     ${e.message}`);
    process.exitCode = 1;
  }
};
const rules = (src, fn = "g.mjs") =>
  detectCircularRefs(src, fn).violations.map((v) => v.rule).sort().join(",");

console.log("§1 검출기 검출력");
check("정상 structural = 위반 0", () =>
  assert.equal(
    rules(`// @crawl-managed-read: structural
const r=JSON.parse(readFileSync("src/lib/constants/players-roster.json","utf8"));
assert.equal(r.length>0,true);`),
    "",
  ),
);
check("값 하드코딩(직접) = value-hardcode", () =>
  assert.equal(
    rules(`// @crawl-managed-read: structural
const p=JSON.parse(readFileSync("src/lib/constants/stats-2026-pitchers.json","utf8"));
assert.equal(p[0].era,2.64);`),
    "value-hardcode",
  ),
);
check("값 하드코딩(1-hop 파생) = value-hardcode", () =>
  assert.equal(
    rules(
      `// @crawl-managed-read: structural
const p=JSON.parse(readFileSync("src/lib/constants/stats-2026-pitchers.json","utf8"));
const k=p.find(x=>x.kboId===52604);
assert.strictEqual(k.era,2.64);`,
      "g.ts",
    ),
    "value-hardcode",
  ),
);
check("애노테이션 없음 = missing-annotation", () =>
  assert.equal(
    rules(`const r=JSON.parse(readFileSync("src/lib/constants/players-roster.json","utf8"));
assert.equal(r.length>0,true);`),
    "missing-annotation",
  ),
);
check("잘못된 mode = invalid-annotation", () =>
  assert.equal(
    rules(`// @crawl-managed-read: whatever
const r=JSON.parse(readFileSync("src/lib/constants/players-roster.json","utf8"));`),
    "invalid-annotation",
  ),
);
check("@crawl-ref-allow 면제 = 위반 0", () =>
  assert.equal(
    rules(`// @crawl-managed-read: fixture
const p=JSON.parse(readFileSync("src/lib/constants/stats-2026-pitchers.json","utf8"));
// @crawl-ref-allow: 합성 fixture
assert.equal(p[0].era,2.64);`),
    "",
  ),
);
check("관리파일 아님 = 위반 0", () =>
  assert.equal(
    rules(`const c=JSON.parse(readFileSync("src/config/other.json","utf8"));
assert.equal(c.version,3);`),
    "",
  ),
);
// 결함주입: 스코프 무시하면 동명이인 오검출 재발 → 스코프 인식이 살아있는지 검증
check("스코프 동명이인은 오검출하지 않는다(합성 mock rows)", () =>
  assert.equal(
    rules(
      `// @crawl-managed-read: structural
const batters=JSON.parse(readFileSync("src/lib/constants/stats-2026-batters.json","utf8"));
function a(){ const rows=fakeFetch(); assert.strictEqual(rows.length,329); }
function b(){ const rows=batters.slice(0,250); return rows; }`,
      "g.ts",
    ),
    "",
  ),
);
// ★ 역순(tainted 스코프가 먼저, mock 스코프가 나중) — pop 이 형제 스코프 taint 를 정리해야만 통과.
// pop 이 빠지면 앞 함수의 batters-유래 rows 가 뒤 함수의 mock rows 를 오염시켜 RED 가 된다.
check("형제 스코프 taint 는 pop 으로 격리된다(역순)", () =>
  assert.equal(
    rules(
      `// @crawl-managed-read: structural
const batters=JSON.parse(readFileSync("src/lib/constants/stats-2026-batters.json","utf8"));
function b(){ const rows=batters.slice(0,250); return rows[0]; }
function a(){ const rows=fakeFetch(); assert.strictEqual(rows.length,329); }`,
      "g.ts",
    ),
    "",
  ),
);
// ★ 중첩 스코프 — 바깥 tainted 변수를 안쪽 함수에서 리터럴 비교하면 chain 검색이 잡아야 한다.
check("중첩 스코프: 바깥 tainted 를 안쪽에서 하드코딩하면 잡는다", () =>
  assert.equal(
    rules(
      `// @crawl-managed-read: structural
const pitchers=JSON.parse(readFileSync("src/lib/constants/stats-2026-pitchers.json","utf8"));
function outer(){ function inner(){ assert.equal(pitchers[0].era, 2.64); } inner(); }`,
      "g.ts",
    ),
    "value-hardcode",
  ),
);
check("같은 스코프 값 하드코딩은 과소검출하지 않는다", () =>
  assert.equal(
    rules(
      `// @crawl-managed-read: structural
const batters=JSON.parse(readFileSync("src/lib/constants/stats-2026-batters.json","utf8"));
function a(){ const top=batters[0]; assert.strictEqual(top.avg,0.312); }`,
      "g.ts",
    ),
    "value-hardcode",
  ),
);
check("import 관리파일 + 값 하드코딩도 잡는다", () =>
  assert.equal(
    rules(
      `// @crawl-managed-read: structural
import roster from "../../src/lib/constants/players-roster.json";
assert.equal(roster[0].kboId, 52604);`,
      "g.ts",
    ),
    "value-hardcode",
  ),
);

console.log("§2 게이트 실행 경로 — 위반 파일을 실제로 RED 낸다");
check("임시 위반 파일 주입 시 게이트 exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "crgate-"));
  try {
    const bad = join(ROOT, "scripts/qa/__crgate_probe_bad__.mjs");
    writeFileSync(
      bad,
      `// @crawl-managed-read: structural
import { readFileSync } from "node:fs";
const p=JSON.parse(readFileSync("src/lib/constants/stats-2026-pitchers.json","utf8"));
assert.equal(p[0].era, 2.64);\n`,
    );
    let exit = 0;
    try {
      execFileSync("node", ["scripts/qa/circular-ref-gate.mjs"], { cwd: ROOT, stdio: "pipe" });
    } catch (e) {
      exit = e.status;
    } finally {
      rmSync(bad, { force: true });
    }
    assert.equal(exit, 1, "위반 파일이 있는데 게이트가 통과했다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
check("위반 파일 제거 후 게이트 exit 0(현재 트리 클린)", () => {
  execFileSync("node", ["scripts/qa/circular-ref-gate.mjs"], { cwd: ROOT, stdio: "pipe" });
});

console.log("§3 레지스트리 ↔ 크롤러 write 경로 동기");
check("레지스트리 관리파일이 전부 크롤러가 write 하는 경로다", () => {
  const crawlers = ["scripts/crawl-roster-v2.mjs", "scripts/crawl-stats.mjs"]
    .map((f) => readFileSync(join(ROOT, f), "utf8"))
    .join("\n");
  for (const managed of CRAWL_MANAGED_FILES) {
    const base = managed.slice(managed.lastIndexOf("/") + 1);
    // 크롤러는 season 을 템플릿으로 쓴다(`stats-${SEASON}-defense.json`). 연도를 4자리수 또는
    // ${SEASON}/${season} 템플릿 자리로 둘 다 허용해 완성 basename 만 찾던 순진한 매칭을 고친다.
    const pattern = base
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/2026/, "(?:\\d{4}|\\$\\{[Ss][Ee][Aa][Ss][Oo][Nn]\\})");
    const re = new RegExp(pattern);
    assert.ok(
      re.test(crawlers),
      `레지스트리의 ${base} 를 크롤러가 write 하지 않는다(SSOT 드리프트)`,
    );
  }
});
check("matchManagedFile 은 부분문자열 오탐을 내지 않는다", () => {
  assert.equal(matchManagedFile("src/lib/constants/players-roster.json"), "players-roster.json");
  assert.equal(matchManagedFile("some/players-roster.json.bak"), null);
  assert.equal(matchManagedFile("evil-players-roster.json"), null);
  assert.equal(matchManagedFile("src/other/config.json"), null);
});

console.log("§4 prebuild 필수 체인 편입 pin(orphan 방지)");
check("package.json 에 qa:circular-ref + prebuild 편입", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(
    pkg.scripts["qa:circular-ref"],
    "node scripts/qa/circular-ref-gate.mjs",
    "qa:circular-ref 스크립트가 없다",
  );
  assert.ok(
    pkg.scripts.prebuild.includes("npm run qa:circular-ref"),
    "prebuild 체인에 qa:circular-ref 가 없다(orphan)",
  );
  assert.equal(
    pkg.scripts["qa:circular-ref-smoke"],
    "node scripts/qa/circular-ref-gate-smoke.mjs",
    "qa:circular-ref-smoke 스크립트가 없다",
  );
  assert.ok(
    pkg.scripts.prebuild.includes("npm run qa:circular-ref-smoke"),
    "prebuild 체인에 qa:circular-ref-smoke 가 없다(orphan)",
  );
});

if (process.exitCode === 1) {
  console.error(`\n❌ 순환참조 게이트 스모크 실패`);
} else {
  console.log(`\n✅ 순환참조 게이트 스모크 ${pass} PASS`);
}
