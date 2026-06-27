#!/usr/bin/env tsx
/**
 * QA: player-photos.ts helper signature + sentinel marker guard
 *
 * Catches regressions where scripts/update-player-photos.mjs (or any other
 * tooling) overwrites the hand-maintained helpers in src/lib/constants/player-photos.ts.
 *
 * Specifically protects against the 2026-05-17 incident:
 *   - The auto roster cron ran the old generator template, which rewrote
 *     getPlayerPhotoUrl back to the 2-arg signature (name, kboId?).
 *   - PR #86 had migrated callers to the 3-arg signature
 *     (name, kboId?, teamId?) + resolvePlayerIdentity().
 *   - Result: TS build failed on auto/update-roster-stats-20260516.
 *
 * Now the generator only replaces the GENERATED:PHOTO_MAP / GENERATED:PHOTO_ID_SET
 * sentinel blocks. This check enforces:
 *   1. Both sentinel pairs are present and balanced.
 *   2. The 3-arg getPlayerPhotoUrl signature is intact.
 *   3. The resolvePlayerIdentity import is intact.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const PHOTOS_TS = path.join(PROJECT_ROOT, "src/lib/constants/player-photos.ts");

const REQUIRED_MARKERS = [
  "// === GENERATED:PHOTO_MAP:BEGIN ===",
  "// === GENERATED:PHOTO_MAP:END ===",
  "// === GENERATED:PHOTO_ID_SET:BEGIN ===",
  "// === GENERATED:PHOTO_ID_SET:END ===",
];

// Match the multi-line 3-arg signature (PR #86 SSOT)
const SIGNATURE_PATTERN =
  /export function getPlayerPhotoUrl\(\s*name:\s*string,\s*kboId\?:\s*string\s*\|\s*null,\s*teamId\?:\s*number\s*\|\s*string\s*\|\s*null,?\s*\):\s*string\s*\|\s*null/;
const RESOLVE_IMPORT_PATTERN =
  /import\s*\{\s*resolvePlayerIdentity\s*\}\s*from\s*["']@\/lib\/utils\/resolve-player["']/;

function fail(msg: string): never {
  console.error(`✗ photos-helper-signature FAILED:\n  ${msg}`);
  process.exit(1);
}

const source = fs.readFileSync(PHOTOS_TS, "utf-8");

// 1. All four sentinel markers present, in order, non-overlapping
let cursor = 0;
for (const marker of REQUIRED_MARKERS) {
  const idx = source.indexOf(marker, cursor);
  if (idx === -1) {
    fail(
      `Missing sentinel marker "${marker}" in ${path.relative(PROJECT_ROOT, PHOTOS_TS)}.\n` +
        `  These markers protect helpers from auto-generation. Re-add them and bound the\n` +
        `  PLAYER_PHOTO_MAP / PLAYER_PHOTO_ID_SET declarations between BEGIN/END pairs.`,
    );
  }
  cursor = idx + marker.length;
}

// 2. 3-arg signature intact
if (!SIGNATURE_PATTERN.test(source)) {
  fail(
    `getPlayerPhotoUrl signature has drifted from the PR #86 SSOT shape:\n` +
      `    (name: string, kboId?: string | null, teamId?: number | string | null) => string | null\n` +
      `  Most likely cause: scripts/update-player-photos.mjs (or another generator) rewrote\n` +
      `  the helper to the old 2-arg template. Restore the 3-arg signature + resolvePlayerIdentity\n` +
      `  resolver, and confirm the generator only touches the GENERATED:* sentinel blocks.`,
  );
}

// 3. resolvePlayerIdentity import intact
if (!RESOLVE_IMPORT_PATTERN.test(source)) {
  fail(
    `Missing 'resolvePlayerIdentity' import from '@/lib/utils/resolve-player'.\n` +
      `  PR #86 SSOT requires this resolver for canonical kboId mapping (foreign players, aliases).`,
  );
}

console.log("✓ photos-helper-signature PASSED");
console.log("  sentinel markers present (4/4)");
console.log("  getPlayerPhotoUrl signature: (name, kboId?, teamId?) ✓");
console.log("  resolvePlayerIdentity import ✓");
