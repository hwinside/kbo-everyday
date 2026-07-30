// Regression for the team-tab back-stack fix (20260730, iOS v1.0.12 CS report).
//
// Symptom: switching between clubs inside the team tab stacked a history
// entry per switch (router.push), so leaving the tab required pressing
// back once per club viewed. Expected: any number of club switches inside
// the team tab is ONE history entry — a single back press exits to the
// screen that preceded the team tab.
//
// Fix: TeamSwitcher club buttons navigate with router.replace.
// Defect injection: changing replace back to push in TeamSwitcher.tsx
// turns this test RED.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(
  resolve(import.meta.dirname, "../../src/components/team/TeamSwitcher.tsx"),
  "utf8",
);

// Club-to-club switching must not stack history entries.
assert.match(
  src,
  /router\.replace\(`\/teams\/\$\{t\.slug\}`\)/,
  "TeamSwitcher must switch clubs via router.replace so the team tab stays one history entry",
);
assert.doesNotMatch(
  src,
  /router\.push\(/,
  "TeamSwitcher must not use router.push — each club switch would stack a back-stack entry",
);

console.log("PASS team-switcher-history-smoke: club switches use router.replace (single back exits the team tab)");
