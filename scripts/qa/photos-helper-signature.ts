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
 * 2026-08-20 (PR #1269): signature SSOT extended to 4 args —
 *   (name, kboId?, teamId?, positionHint?) — positionHint("투수"|"야수") disambiguates
 *   same-team duplicate names (삼성 김태훈 투수 62360 vs 야수 65040). This gate now
 *   enforces the 4-arg shape; a generator rewriting it back to 2- or 3-arg fails here.
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

// Match the multi-line 4-arg signature (PR #86 SSOT + PR #1269 positionHint)
const SIGNATURE_PATTERN =
  /export function getPlayerPhotoUrl\(\s*name:\s*string,\s*kboId\?:\s*string\s*\|\s*null,\s*teamId\?:\s*number\s*\|\s*string\s*\|\s*null,\s*positionHint\?:\s*"투수"\s*\|\s*"야수"\s*\|\s*null,?\s*\):\s*string\s*\|\s*null/;
// resolvePlayerIdentity 가 named import 목록 안에 있으면 통과 (PR #1269 부터 rosterNameMatchCount 동반)
const RESOLVE_IMPORT_PATTERN =
  /import\s*\{[^}]*\bresolvePlayerIdentity\b[^}]*\}\s*from\s*["']@\/lib\/utils\/resolve-player["']/;

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

// 2. 4-arg signature intact
if (!SIGNATURE_PATTERN.test(source)) {
  fail(
    `getPlayerPhotoUrl signature has drifted from the SSOT shape (PR #86 + PR #1269):\n` +
      `    (name: string, kboId?: string | null, teamId?: number | string | null, positionHint?: "투수" | "야수" | null) => string | null\n` +
      `  Most likely cause: scripts/update-player-photos.mjs (or another generator) rewrote\n` +
      `  the helper to an old 2-/3-arg template. Restore the 4-arg signature + resolvePlayerIdentity\n` +
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
console.log("  getPlayerPhotoUrl signature: (name, kboId?, teamId?, positionHint?) ✓");
console.log("  resolvePlayerIdentity import ✓");
