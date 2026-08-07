#!/usr/bin/env node
// @crawl-managed-read: structural  (크롤 관리 데이터 파일을 구조·불변식 검증에만 사용 — 값 하드코딩 금지, 축② 순환참조 메타게이트)
/**
 * roster JSON(SSOT)이 바뀐 자동 PR에서 data artifact인 source inventory만 동기화한다.
 *
 * 런타임 소스와 이미 선적된 migration은 자동 크롤이 절대 수정하지 않는다. roster
 * 안전성은 현재 JSON의 shape/team/canary 검증과 workflow의 roster-size delta+ack가 맡고,
 * DB source 변경은 append-only migration 또는 별도 검증된 upsert 경로로 선적한다.
 *
 * Usage:
 *   node scripts/ci/sync-roster-derived-artifacts.mjs
 *   node scripts/ci/sync-roster-derived-artifacts.mjs --check
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const roster = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/constants/players-roster.json"), "utf8"));
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "data/baseball-qa/source-inventory.json"), "utf8"));

assert.ok(Array.isArray(roster) && roster.length > 0, "roster SSOT must be a non-empty array");

if (process.argv.includes("--check")) {
  const rosterIds = [...new Set(roster.map((player) => String(player.kboId)))].sort();
  const inventoryIds = inventory.sources
    .filter((source) => source.entityType === "player")
    .map((source) => String(source.entityId))
    .sort();
  assert.equal(rosterIds.length, roster.length, "roster kboId must be unique");
  assert.deepEqual(inventoryIds, rosterIds, "source inventory player set must exactly match roster SSOT");
  console.log(`✅ roster↔inventory exact relationship (${roster.length}명)`);
  process.exit(0);
}

execFileSync(
  "npx",
  ["tsx", "scripts/baseball-qa/build-source-inventory.ts", "--inventory-only"],
  { cwd: ROOT, stdio: "inherit" },
);
console.log(`🔧 roster-derived data artifact sync complete (${roster.length}명, inventory-only)`);
