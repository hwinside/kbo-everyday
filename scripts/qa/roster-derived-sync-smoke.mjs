#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

check("reviewed bootstrap seed migration remains byte-identical to main", () => {
  const baseline = execFileSync("git", ["show", "origin/main:supabase/migrations/20260731_baseball_genius_rag_sources_seed.sql"], {
    cwd: ROOT, encoding: "utf8",
  });
  assert.equal(read("supabase/migrations/20260731_baseball_genius_rag_sources_seed.sql"), baseline);
});

check("nationality and pending reports are disjoint", () => {
  const pending = JSON.parse(read("src/lib/constants/foreign-nationality-pending.json"));
  const nationality = JSON.parse(read("src/lib/constants/player-nationality.json"));
  assert.deepEqual(Object.keys(pending).filter((id) => nationality[id]), []);
});

check("prebuild includes the read-only relationship gate", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts["qa:roster-derived-sync"], "node scripts/ci/sync-roster-derived-artifacts.mjs --check");
  assert.ok(pkg.scripts.prebuild.includes("qa:roster-derived-sync"));
});

console.log(`\nPASS — roster derived sync contract (${pass} pass, roster ${roster.length}명)`);
