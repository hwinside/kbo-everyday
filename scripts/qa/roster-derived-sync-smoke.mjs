#!/usr/bin/env node
/**
 * roster 파생 산출물 동기화 계약 회귀 (2026-08-01 P0 재발 방지).
 * 실행: node scripts/qa/roster-derived-sync-smoke.mjs (npm run qa:roster-derived-sync-smoke)
 *
 * 지키는 계약 (하나라도 되돌리면 카라스코(56103) 사고가 그대로 재발한다):
 *   ① 게이트 스크립트에 roster 인원 숫자를 하드코딩하지 않는다.
 *   ② sync-roster-derived-artifacts.mjs --check 는 상수 drift를 실제로 잡는다(결함주입).
 *   ③ sync 스크립트는 drift를 실제로 고친다(그리고 roster JSON 자체는 건드리지 않는다).
 *   ④ 자동 크롤 워크플로가 sync 스텝을 photos 갱신 뒤에 실행한다.
 *   ⑤ 자동 머지 allowlist가 파생 산출물 + 국적 대기 리포트를 허용하고,
 *      워크플로/무관 코드 파일은 여전히 차단한다.
 *   ⑥ prebuild 체인이 --check 게이트를 포함한다.
 *
 * 원본 파일은 임시 사본에서만 변형하고, 워킹트리 파일은 실행 후 원상복구한다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (e) {
    console.error(`✗ ${name}\n  ${e.message.split("\n")[0]}`);
    failures.push(name);
  }
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const rosterCount = JSON.parse(read("src/lib/constants/players-roster.json")).length;

// ── ① 게이트 스크립트 하드코딩 금지 ────────────────────────────────────────
// 878처럼 "지금 마침 맞는 숫자"를 박으면 다음 콜업에서 자동 PR이 죽는다.
const NO_HARDCODE_TARGETS = [
  "scripts/qa/baseball-qa-source-inventory-smoke.ts",
  "scripts/qa/baseball-qa-pipeline-smoke.ts",
];
// roster 인원과 묶이는 식별자를 다루는 라인에서만 숫자 리터럴을 금지한다.
// (무조건 3자리 숫자를 막으면 SQL 계약 문자열 같은 무관한 값까지 잡는다 — 실제로 900에 걸렸다.)
const ROSTER_LINKED_TOKENS = [
  "roster.length",
  "playersRoster.length",
  "playerSources.length",
  "inventory.sources.length",
  "ROSTER_COUNT",
  "coverage",
  "pending:",
  "total:",
  "seed.match",
];
for (const rel of NO_HARDCODE_TARGETS) {
  check(`① ${rel}: roster 인원 하드코딩 없음`, () => {
    const src = read(rel);
    const codeLines = src
      .split("\n")
      // 주석은 설명으로 숫자를 쓸 수 있으므로 제외
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"));
    for (const line of codeLines) {
      if (!ROSTER_LINKED_TOKENS.some((token) => line.includes(token))) continue;
      // roster 인원/소스 개수대에 해당하는 숫자가 리터럴로 박혀 있으면 실패(현재값·과거값 무관).
      const hits = line.match(/\b(8[0-9]{2}|9[0-9]{2}|1[0-9]{3})\b/g);
      if (!hits) continue;
      assert.fail(`roster 인원 리터럴 발견: ${line.trim()}`);
    }
  });
}

// ── ②③ 결함주입: 사본 repo에서 roster를 +1 해 drift를 만든다 ───────────────
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "roster-derived-sync-"));
try {
  // 검사에 필요한 최소 파일만 복사(대용량 repo 복제 금지).
  const NEEDED = [
    "src/lib/constants/players-roster.json",
    "src/app/api/roster/route.ts",
    "src/app/api/health/roster/route.ts",
    "scripts/validate-roster.mjs",
    "scripts/ci/sync-roster-derived-artifacts.mjs",
  ];
  for (const rel of NEEDED) {
    const dest = path.join(sandbox, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dest);
  }

  const rosterPath = path.join(sandbox, "src/lib/constants/players-roster.json");
  const original = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
  const drifted = [...original, { ...original[0], kboId: "QA_SYNTHETIC", name: "회귀용가상선수" }];
  fs.writeFileSync(rosterPath, JSON.stringify(drifted, null, 2));

  const runCheck = () => {
    try {
      execFileSync("node", ["scripts/ci/sync-roster-derived-artifacts.mjs", "--check"], {
        cwd: sandbox,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0 };
    } catch (e) {
      return { code: e.status ?? 1, err: String(e.stderr ?? "") };
    }
  };

  check("② --check 가 상수 drift를 실제로 잡는다(결함주입 RED)", () => {
    const r = runCheck();
    assert.notEqual(r.code, 0, "drift 상태인데 --check 가 통과했다");
    assert.match(r.err, /EXPECTED_ROSTER_COUNT/, "drift 대상 상수를 지목해야 한다");
  });

  check("② --check 는 파일을 수정하지 않는다(읽기 전용)", () => {
    const before = NEEDED.filter((rel) => rel !== "src/lib/constants/players-roster.json")
      .map((rel) => fs.readFileSync(path.join(sandbox, rel), "utf8"));
    runCheck();
    const after = NEEDED.filter((rel) => rel !== "src/lib/constants/players-roster.json")
      .map((rel) => fs.readFileSync(path.join(sandbox, rel), "utf8"));
    assert.deepEqual(after, before);
  });

  check("③ 동기화 실행이 상수 3곳을 roster 실제값으로 맞춘다", () => {
    // 생성기(build-source-inventory)는 sandbox에 없으므로 상수 경로만 검증한다.
    const script = path.join(sandbox, "scripts/ci/sync-roster-derived-artifacts.mjs");
    const src = fs.readFileSync(script, "utf8");
    fs.writeFileSync(
      script,
      src.replace(/execFileSync\("npx"[\s\S]*?\);/, "/* sandbox: 생성기 호출 생략 */"),
    );
    execFileSync("node", ["scripts/ci/sync-roster-derived-artifacts.mjs"], {
      cwd: sandbox,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const want = drifted.length;
    for (const [rel, name] of [
      ["src/app/api/roster/route.ts", "EXPECTED_ROSTER_COUNT"],
      ["src/app/api/health/roster/route.ts", "EXPECTED_ROSTER_COUNT"],
      ["scripts/validate-roster.mjs", "EXPECTED_COUNT"],
    ]) {
      const got = Number(
        fs.readFileSync(path.join(sandbox, rel), "utf8").match(new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)`))[1],
      );
      assert.equal(got, want, `${rel} 상수가 ${want}로 동기화되지 않음`);
    }
  });

  check("③ 동기화는 roster JSON(진실)을 건드리지 않는다", () => {
    const now = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
    assert.equal(now.length, drifted.length);
    assert.deepEqual(now, drifted);
  });
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

// ── ④⑤ 워크플로 계약 ──────────────────────────────────────────────────────
const workflow = read(".github/workflows/update-roster-stats.yml");

check("④ 자동 크롤 워크플로에 sync 스텝이 있다", () => {
  assert.ok(
    workflow.includes("node scripts/ci/sync-roster-derived-artifacts.mjs"),
    "sync 스텝이 없으면 roster 변경 PR이 파생값 구값을 안고 올라간다",
  );
});

check("④ sync 스텝은 photos 갱신 뒤·변경 감지 앞에 있다", () => {
  const iPhotos = workflow.indexOf("node scripts/update-player-photos.mjs");
  const iSync = workflow.indexOf("node scripts/ci/sync-roster-derived-artifacts.mjs");
  const iChanges = workflow.indexOf("name: Check for changes");
  assert.ok(iPhotos !== -1 && iSync !== -1 && iChanges !== -1);
  assert.ok(iPhotos < iSync, "photos 갱신보다 먼저 돌면 photo-map 파생을 놓친다");
  assert.ok(iSync < iChanges, "변경 감지 뒤에 돌면 동기화 결과가 커밋에 안 들어간다");
});

const allowlistRe = (() => {
  const m = workflow.match(/ALLOWLIST_RE='(.+)'/);
  assert.ok(m, "ALLOWLIST_RE 를 워크플로에서 찾지 못함");
  return new RegExp(m[1]);
})();

const ALLOWED = [
  "public/players/56103.jpg",
  "src/lib/constants/players-roster.json",
  "src/lib/constants/player-photos.ts",
  "src/lib/constants/foreign-nationality-pending.json",
  "src/lib/constants/stats-2026-defense.json",
  "src/lib/constants/stats-2026-meta.json",
  "src/app/api/roster/route.ts",
  "src/app/api/health/roster/route.ts",
  "scripts/validate-roster.mjs",
  "data/baseball-qa/source-inventory.json",
  "supabase/migrations/20260731_baseball_genius_rag_sources_seed.sql",
];
// 자동 크롤이 절대 건드리면 안 되는 것들 — 여기가 뚫리면 allowlist 가드 자체가 무의미해진다.
const BLOCKED = [
  ".github/workflows/update-roster-stats.yml",
  "package.json",
  "src/app/api/games/route.ts",
  "scripts/ci/sync-roster-derived-artifacts.mjs",
  "src/lib/constants/player-nationality.json",
  "supabase/migrations/20260801_something_else.sql",
  "src/lib/baseball-qa/source-inventory.ts",
];

check("⑤ allowlist가 파생 산출물·국적 대기 리포트를 허용한다", () => {
  for (const f of ALLOWED) assert.ok(allowlistRe.test(f), `허용돼야 하는데 차단됨: ${f}`);
});

check("⑤ allowlist가 워크플로·무관 코드·다른 migration은 계속 차단한다", () => {
  for (const f of BLOCKED) assert.ok(!allowlistRe.test(f), `차단돼야 하는데 통과됨: ${f}`);
});

// ── ⑥ prebuild 체인 결속 ──────────────────────────────────────────────────
check("⑥ prebuild 체인에 --check 게이트가 있다", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts["qa:roster-derived-sync"], "node scripts/ci/sync-roster-derived-artifacts.mjs --check");
  assert.ok(pkg.scripts.prebuild.includes("qa:roster-derived-sync"));
});

console.log(
  `\n${failures.length === 0 ? "PASS" : "FAIL"} — roster derived sync contract ` +
    `(${pass} pass, ${failures.length} fail, roster ${rosterCount}명)`,
);
process.exit(failures.length === 0 ? 0 : 1);
