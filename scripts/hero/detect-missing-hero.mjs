#!/usr/bin/env node
// scripts/hero/detect-missing-hero.mjs
//
// 신규 hero 생성/검수가 필요한 kboId를 식별한다.
// SSOT 원칙 준수 — read only.
//
// 입력:
//   - src/lib/constants/players-roster.json (roster SSOT)
//   - src/lib/constants/hero-approved-kboids.json (allow-list)
//   - public/players-hero-v2/webp/*.webp (생성 자산)
//
// 출력 (stdout JSON):
//   {
//     generatedAt, totalRoster, approvedCount, webpCount, candidatesCount,
//     reasons: { no_webp: N, generated_unapproved: M },
//     candidates: [{ kboId, name, team, teamId, position, reason }]
//   }
//
// reason:
//   - "no_webp": 로스터에 있고 webp 없음 → 신규 생성 후보
//   - "generated_unapproved": webp 있으나 approved에 없음 → 검수 대기
//
// 사용:
//   node scripts/hero/detect-missing-hero.mjs
//   node scripts/hero/detect-missing-hero.mjs --pretty
//   node scripts/hero/detect-missing-hero.mjs --only=no_webp
//   node scripts/hero/detect-missing-hero.mjs --only=generated_unapproved

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

const args = process.argv.slice(2);
const pretty = args.includes("--pretty");
const onlyArg = args.find((a) => a.startsWith("--only="));
const onlyReason = onlyArg ? onlyArg.split("=")[1] : null;

const roster = JSON.parse(
  readFileSync(resolve(ROOT, "src/lib/constants/players-roster.json"), "utf8"),
);
const approvedList = JSON.parse(
  readFileSync(resolve(ROOT, "src/lib/constants/hero-approved-kboids.json"), "utf8"),
);
const approved = new Set(approvedList.map(String));

const webpDir = resolve(ROOT, "public/players-hero-v2/webp");
const webpSet = new Set(
  readdirSync(webpDir)
    .filter((f) => f.endsWith(".webp"))
    .map((f) => f.replace(/\.webp$/, "")),
);

const candidates = [];
for (const player of roster) {
  const kboId = String(player.kboId);
  const hasWebp = webpSet.has(kboId);
  const isApproved = approved.has(kboId);

  let reason = null;
  if (!hasWebp) reason = "no_webp";
  else if (!isApproved) reason = "generated_unapproved";

  if (reason && (!onlyReason || onlyReason === reason)) {
    candidates.push({
      kboId,
      name: player.name ?? null,
      team: player.team ?? null,
      teamId: player.teamId ?? null,
      position: player.position ?? null,
      reason,
    });
  }
}

const reasons = candidates.reduce((acc, c) => {
  acc[c.reason] = (acc[c.reason] ?? 0) + 1;
  return acc;
}, {});

const output = {
  generatedAt: new Date().toISOString(),
  totalRoster: roster.length,
  approvedCount: approvedList.length,
  webpCount: webpSet.size,
  candidatesCount: candidates.length,
  reasons,
  candidates,
};

process.stdout.write(JSON.stringify(output, null, pretty ? 2 : 0) + "\n");
