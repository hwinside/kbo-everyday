#!/usr/bin/env node
// T6: roster SSOT 오염 레코드 3건 제거
// - NC 59378 (김명규\r\n): 정상 레코드 56944 이미 존재하는 크롤러 오인식 중복
// - NC 59377 (신재인\r\n): 정상 레코드 56909 이미 존재하는 크롤러 오인식 중복
// - LG 96153 (이정준): position/backNo 공란 유령 레코드

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROSTER_PATH = path.resolve(__dirname, "../src/lib/constants/players-roster.json");

const GHOST_IDS = new Set(["59378", "59377", "96153"]);

const raw = fs.readFileSync(ROSTER_PATH, "utf8");
const roster = JSON.parse(raw);
const before = roster.length;

const cleaned = roster.filter((p) => {
  if (GHOST_IDS.has(String(p.kboId))) {
    console.log(`removed: kboId=${p.kboId} name=${JSON.stringify(p.name)} team=${p.team}`);
    return false;
  }
  return true;
});

const after = cleaned.length;
console.log(`\ntotal: ${before} -> ${after} (removed ${before - after})`);

if (before - after !== 3) {
  console.error(`\n❌ expected to remove 3, actually removed ${before - after}. Aborting.`);
  process.exit(1);
}

fs.writeFileSync(ROSTER_PATH, JSON.stringify(cleaned, null, 2) + "\n", "utf8");
console.log(`\n✅ wrote ${ROSTER_PATH} (${after} players)`);
