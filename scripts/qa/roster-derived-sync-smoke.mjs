#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
let pass = 0;
const check = (name, fn) => { fn(); console.log(`✓ ${name}`); pass++; };

const roster = JSON.parse(read("src/lib/constants/players-roster.json"));
const inventory = JSON.parse(read("data/baseball-qa/source-inventory.json"));

check("inventory player set exactly matches roster SSOT", () => {
  const rosterIds = roster.map((p) => String(p.kboId)).sort();
  const sourceIds = inventory.sources.filter((s) => s.entityType === "player")
    .map((s) => String(s.entityId)).sort();
  assert.deepEqual(sourceIds, rosterIds);
});

check("sync --check catches a missing inventory player without writing", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "roster-derived-check-"));
  try {
    for (const rel of [
      "scripts/ci/sync-roster-derived-artifacts.mjs",
      "src/lib/constants/players-roster.json",
      "data/baseball-qa/source-inventory.json",
    ]) {
      const dest = path.join(sandbox, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), dest);
    }
    const target = path.join(sandbox, "data/baseball-qa/source-inventory.json");
    const broken = JSON.parse(fs.readFileSync(target, "utf8"));
    broken.sources = broken.sources.filter((s) => s.sourceKey !== "namu:player:56103");
    fs.writeFileSync(target, JSON.stringify(broken));
    const before = fs.readFileSync(target, "utf8");
    assert.throws(() => execFileSync("node", ["scripts/ci/sync-roster-derived-artifacts.mjs", "--check"], {
      cwd: sandbox, stdio: "pipe",
    }));
    assert.equal(fs.readFileSync(target, "utf8"), before);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

check("inventory-only generator never writes the seed migration", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roster-inventory-only-"));
  try {
    const out = path.join(dir, "inventory.json");
    const seed = path.join(dir, "seed.sql");
    fs.copyFileSync(path.join(ROOT, "data/baseball-qa/source-inventory.json"), out);
    fs.writeFileSync(seed, "DO NOT TOUCH\n");
    execFileSync("npx", ["tsx", "scripts/baseball-qa/build-source-inventory.ts", out, seed, "--inventory-only"], {
      cwd: ROOT, stdio: "pipe",
    });
    assert.equal(fs.readFileSync(seed, "utf8"), "DO NOT TOUCH\n");
    assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), inventory);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const workflow = read(".github/workflows/update-roster-stats.yml");
check("workflow runs inventory sync after photos and before change detection", () => {
  const photos = workflow.indexOf("node scripts/update-player-photos.mjs");
  const sync = workflow.indexOf("node scripts/ci/sync-roster-derived-artifacts.mjs");
  const changes = workflow.indexOf("name: Check for changes");
  assert.ok(photos < sync && sync < changes);
});

const allowlist = new RegExp(workflow.match(/ALLOWLIST_RE='(.+)'/)[1]);
check("auto-merge allowlist is data-only", () => {
  for (const file of [
    "src/lib/constants/players-roster.json",
    "src/lib/constants/foreign-nationality-pending.json",
    "data/baseball-qa/source-inventory.json",
    "public/players/56103.jpg",
  ]) assert.ok(allowlist.test(file), `expected allowed: ${file}`);
  for (const file of [
    "src/app/api/roster/route.ts",
    "src/app/api/health/roster/route.ts",
    "scripts/validate-roster.mjs",
    ".github/workflows/update-roster-stats.yml",
    "supabase/migrations/20260731_baseball_genius_rag_sources_seed.sql",
    "supabase/migrations/20260801_any.sql",
  ]) assert.ok(!allowlist.test(file), `expected blocked: ${file}`);
});

// remote ref에 의존하면 shallow clone·Vercel 빌드 환경에서 검사가 조용히 무력해질 수 있다.
// 리뷰·머지된 bootstrap migration은 불변이므로 고정 SHA-256으로 잠근다.
const BOOTSTRAP_SEED_PATH = "supabase/migrations/20260731_baseball_genius_rag_sources_seed.sql";
const BOOTSTRAP_SEED_SHA256 = "0462100bd093a9f1e6d18c7d5feb759df7ba368bffc0d3a620fecda31f25660b";
check("reviewed bootstrap seed migration is immutable (fixed SHA-256)", () => {
  const actual = createHash("sha256").update(fs.readFileSync(path.join(ROOT, BOOTSTRAP_SEED_PATH))).digest("hex");
  assert.equal(actual, BOOTSTRAP_SEED_SHA256, `${BOOTSTRAP_SEED_PATH} was modified; it must stay immutable`);
});

// P0 재발 경로 직접 봉쇄: 기본 생성 명령이 과거 migration을 건드리면 안 된다.
check("default build command never touches the bootstrap migration", () => {
  const before = fs.readFileSync(path.join(ROOT, BOOTSTRAP_SEED_PATH), "utf8");
  const inventoryBefore = read("data/baseball-qa/source-inventory.json");
  execFileSync("npm", ["run", "-s", "build:baseball-source-inventory"], { cwd: ROOT, stdio: "pipe" });
  assert.equal(fs.readFileSync(path.join(ROOT, BOOTSTRAP_SEED_PATH), "utf8"), before,
    "무옵션 build 명령이 bootstrap migration을 덮어썼다");
  assert.equal(read("data/baseball-qa/source-inventory.json"), inventoryBefore,
    "committed inventory가 생성기 재실행과 일치해야 한다(결정론성)");
});

// seed 재생성은 명시 옵션을 줘도 기존 파일이 있으면 fail-close여야 한다.
check("--emit-seed refuses to overwrite an existing migration", () => {
  let threw = false;
  try {
    execFileSync("npm", ["run", "-s", "build:baseball-source-inventory:seed"], { cwd: ROOT, stdio: "pipe" });
  } catch {
    threw = true;
  }
  assert.ok(threw, "기존 migration이 있는데 --emit-seed 가 성공하면 안 된다");
  const actual = createHash("sha256").update(fs.readFileSync(path.join(ROOT, BOOTSTRAP_SEED_PATH))).digest("hex");
  assert.equal(actual, BOOTSTRAP_SEED_SHA256, "거부된 뒤에도 원본이 그대로여야 한다");
});

check("nationality and pending reports are disjoint", () => {
  const pending = JSON.parse(read("src/lib/constants/foreign-nationality-pending.json"));
  const nationality = JSON.parse(read("src/lib/constants/player-nationality.json"));
  assert.deepEqual(Object.keys(pending).filter((id) => nationality[id]), []);
});

check("prebuild runs both the relationship gate and this smoke", () => {
  const pkg = JSON.parse(read("package.json"));
  const gate = pkg.scripts["qa:roster-derived-sync"];
  // 이 smoke 자체가 CI에 안 묶이면 위 검사가 전부 false-green이 된다(삼순 2차 NO-GO).
  assert.ok(gate.includes("sync-roster-derived-artifacts.mjs --check"), "relationship gate가 빠졌다");
  assert.ok(gate.includes("roster-derived-sync-smoke.mjs"), "smoke 가 CI에 결속되지 않았다");
  assert.ok(pkg.scripts.prebuild.includes("prebuild-gates.mjs"), "prebuild가 게이트 러너를 호출하지 않는다");
  const gateList = execFileSync("node", ["scripts/ci/prebuild-gates.mjs", "--list"], { encoding: "utf8" });
  assert.match(gateList, /^(pool|serial|exclusive)\tqa:roster-derived-sync$/m);
  assert.match(gateList, /^(pool|serial|exclusive)\tqa:roster-preservation$/m, "군입대 선수 보존 회귀가 prebuild에서 빠졌다");
  assert.equal(pkg.scripts["build:baseball-source-inventory"], "tsx scripts/baseball-qa/build-source-inventory.ts");
});

console.log(`\nPASS — roster derived sync contract (${pass} pass, roster ${roster.length}명)`);
