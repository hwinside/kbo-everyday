#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preserveExistingRosterPlayers } from "../lib/roster-preservation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let pass = 0;
const check = (name, fn) => {
  fn();
  console.log(`✓ ${name}`);
  pass++;
};

check("군입대 선수는 기록 수집에 없어도 기존 SSG roster에서 보존", () => {
  const armyPlayer = {
    name: "이율예",
    kboId: "55832",
    teamId: 4,
    position: "포수",
    backNo: "22",
    team: "SSG",
    birthDate: "2006-11-21",
  };
  const collected = new Map();
  const existing = new Map([[armyPlayer.kboId, armyPlayer]]);
  assert.equal(preserveExistingRosterPlayers(collected, existing, (id) => id), 1);
  assert.deepEqual(collected.get("55832"), armyPlayer);
});

check("이율예 roster·사진 매핑·JPEG가 함께 선적됨", () => {
  const roster = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/constants/players-roster.json"), "utf8"));
  assert.deepEqual(roster.filter((player) => player.kboId === "55832"), [{
    name: "이율예",
    kboId: "55832",
    teamId: 4,
    position: "포수",
    backNo: "22",
    team: "SSG",
    birthDate: "2006-11-21",
  }]);
  const photoIndex = fs.readFileSync(path.join(ROOT, "src/lib/constants/player-photos.ts"), "utf8");
  assert.match(photoIndex, /"이율예": "55832"/);
  assert.match(photoIndex, /"55832"/);
  const photo = fs.readFileSync(path.join(ROOT, "public/players/55832.jpg"));
  assert.ok(photo.length > 500);
  assert.deepEqual([...photo.subarray(0, 2)], [0xff, 0xd8], "JPEG SOI signature");
});

check("같은 ID가 이번 수집에 있으면 최신 수집값을 기존값으로 덮지 않음", () => {
  const fresh = { name: "이율예", kboId: "55832", teamId: 4, team: "SSG", backNo: "44" };
  const stale = { ...fresh, backNo: "22" };
  const collected = new Map([[fresh.kboId, fresh]]);
  const existing = new Map([[stale.kboId, stale]]);
  assert.equal(preserveExistingRosterPlayers(collected, existing, (id) => id), 0);
  assert.equal(collected.get("55832"), fresh);
});

check("외국인 숫자 alias는 canonical ID로 보존하고 중복 행을 만들지 않음", () => {
  const existing = new Map([["56146", { name: "히우라", kboId: "56146", teamId: 6 }]]);
  const collected = new Map([["FP021", { name: "히우라", kboId: "FP021", teamId: 6 }]]);
  const canonical = (id) => id === "56146" ? "FP021" : id;
  assert.equal(preserveExistingRosterPlayers(collected, existing, canonical), 0);
  assert.equal(collected.size, 1);
});

console.log(`\nPASS — roster preservation (${pass} pass)`);
