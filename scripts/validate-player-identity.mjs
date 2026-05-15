#!/usr/bin/env node
/**
 * Player Identity Validator
 *
 * Fail-fast gate for the product-level invariant:
 * every player token that can be exposed in UI/API data must resolve to one
 * canonical roster player, and that canonical player must have a usable photo
 * and canonical /community/players/{kboId} link.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const roster = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/constants/players-roster.json"), "utf8"));
const batters = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/constants/stats-2026-batters.json"), "utf8"));
const pitchers = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/constants/stats-2026-pitchers.json"), "utf8"));
const photoSource = fs.readFileSync(path.join(ROOT, "src/lib/constants/player-photos.ts"), "utf8");
const foreignSource = fs.readFileSync(path.join(ROOT, "src/lib/constants/foreign-id-map.ts"), "utf8");

const foreignNumericToAlpha = Object.fromEntries(
  [...foreignSource.matchAll(/"(\d+)":\s*"((?:FP|AQ)\d+)"/g)].map((m) => [m[1], m[2]]),
);
const foreignAlphaToNumeric = Object.fromEntries(
  Object.entries(foreignNumericToAlpha).map(([numeric, alpha]) => [alpha, numeric]),
);
const photoIds = new Set([...photoSource.matchAll(/"([A-Z]{2}\d{3}|\d{5})"/g)].map((m) => m[1]));
const byId = new Map(roster.map((p) => [String(p.kboId), p]));
const errors = [];
const warnings = [];

function fail(msg) { errors.push(msg); }
function warn(msg) { warnings.push(msg); }

function resolvePlayer({ name, kboId, playerId, id, team, teamId }) {
  const rawId = kboId ?? playerId ?? id;
  if (rawId !== undefined && rawId !== null && String(rawId).trim()) {
    const token = String(rawId).trim();
    const direct = byId.get(token);
    if (direct) return direct;
    const alpha = foreignNumericToAlpha[token];
    if (alpha && byId.has(alpha)) return byId.get(alpha);
  }

  const cleanName = name?.trim?.();
  if (!cleanName) return null;
  const cleanTeam = team?.trim?.();
  const numericTeamId = teamId !== undefined && teamId !== null && String(teamId).trim()
    ? Number(teamId)
    : null;

  const exactTeam = roster.find((p) => p.name === cleanName && (
    (numericTeamId !== null && Number(p.teamId) === numericTeamId) ||
    (cleanTeam && p.team === cleanTeam)
  ));
  if (exactTeam) return exactTeam;

  const suffixTeam = roster.find((p) => p.name.endsWith(cleanName) && (
    (numericTeamId !== null && Number(p.teamId) === numericTeamId) ||
    (cleanTeam && p.team === cleanTeam)
  ));
  if (suffixTeam) return suffixTeam;

  const exact = roster.filter((p) => p.name === cleanName);
  if (exact.length === 1) return exact[0];
  const suffix = roster.filter((p) => p.name.endsWith(cleanName));
  if (suffix.length === 1) return suffix[0];
  return null;
}

function assertVisibleToken(label, token) {
  const resolved = resolvePlayer(token);
  if (!resolved) {
    fail(`${label}: cannot resolve ${JSON.stringify(token)}`);
    return;
  }
  const canonicalId = String(resolved.kboId);
  const numericId = foreignAlphaToNumeric[canonicalId] || canonicalId;
  if (!photoIds.has(canonicalId) && !photoIds.has(numericId)) {
    fail(`${label}: ${resolved.name} (${canonicalId}/${numericId}) has no photo id`);
  }
  if (!canonicalId || canonicalId === "0") {
    fail(`${label}: ${resolved.name} resolved to invalid canonical id ${canonicalId}`);
  }
}

// Foreign aliases must converge to one canonical roster entry with a photo.
for (const [numeric, alpha] of Object.entries(foreignNumericToAlpha)) {
  const byNumeric = resolvePlayer({ kboId: numeric });
  const byAlpha = resolvePlayer({ kboId: alpha });
  if (!byNumeric || !byAlpha) {
    fail(`foreign ${numeric}->${alpha}: alias or canonical id does not resolve`);
    continue;
  }
  if (byNumeric.kboId !== byAlpha.kboId || byAlpha.kboId !== alpha) {
    fail(`foreign ${numeric}->${alpha}: does not converge (numeric=${byNumeric.kboId}, alpha=${byAlpha.kboId})`);
  }
  assertVisibleToken(`foreign ${numeric}->${alpha}`, { kboId: numeric });
  assertVisibleToken(`foreign short/full ${numeric}->${alpha}`, {
    name: byAlpha.name.replace(/^[^ ]+\s+/, ""),
    teamId: byAlpha.teamId,
  });
}

// Rankings/stats are directly rendered in standings and rankings pages.
for (const [kind, rows] of [["batter", batters], ["pitcher", pitchers]]) {
  rows.forEach((row, index) => {
    assertVisibleToken(`stats-2026-${kind}[${index}] ${row.name}`, {
      name: row.name,
      kboId: row.kboId,
      playerId: row.playerId,
      team: row.team,
    });
  });
}

// Roster entries are selectable/searchable; warn on photo gaps for official-photo-unavailable cases.
for (const p of roster) {
  const numericId = foreignAlphaToNumeric[p.kboId] || p.kboId;
  if (!photoIds.has(p.kboId) && !photoIds.has(numericId)) {
    warn(`roster photo missing: ${p.team} ${p.name} (${p.kboId}/${numericId})`);
  }
}

// Architecture guard: UI/game/ranking code must not import foreign-id-map directly.
const sourceFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(ts|tsx)$/.test(entry.name)) sourceFiles.push(full);
  }
}
walk(path.join(ROOT, "src"));
const foreignAllowed = new Set([
  path.join(ROOT, "src/lib/constants/foreign-id-map.ts"),
  path.join(ROOT, "src/lib/utils/resolve-player.ts"),
  path.join(ROOT, "src/app/api/roster/route.ts"),
]);
for (const file of sourceFiles) {
  const txt = fs.readFileSync(file, "utf8");
  if (txt.includes("@/lib/constants/foreign-id-map") && !foreignAllowed.has(file)) {
    fail(`architecture: ${path.relative(ROOT, file)} imports foreign-id-map directly; use resolvePlayerIdentity`);
  }
}

console.log("");
console.log("Player Identity Validator");
console.log(`  roster=${roster.length} batters=${batters.length} pitchers=${pitchers.length} foreign_aliases=${Object.keys(foreignNumericToAlpha).length}`);
console.log("");
if (warnings.length) {
  console.log(`⚠️  ${warnings.length} warning(s):`);
  warnings.slice(0, 20).forEach((w) => console.log(`   - ${w}`));
  if (warnings.length > 20) console.log(`   ... ${warnings.length - 20} more`);
  console.log("");
}
if (errors.length) {
  console.log(`❌ ${errors.length} error(s):`);
  errors.forEach((e) => console.log(`   - ${e}`));
  console.log("");
  console.error("FAIL — player identity invariant blocked.");
  process.exit(1);
}
console.log("✅ PASS — player identity/photo/link invariant is clean.");
