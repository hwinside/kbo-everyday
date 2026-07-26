import { resolveCurrentAtBat } from "../../src/lib/game/current-at-bat";
import { afterFinalFetch, planFinalFetch } from "../../src/lib/hooks/final-relay-fetch";
import type { InningRelay } from "../../src/app/api/game-relay/route";

let passed = 0;
function check(name: string, condition: boolean) {
  if (!condition) throw new Error(name);
  passed++;
}

const terminalInning: InningRelay = {
  inning: 7,
  half: "bottom",
  teamName: "LG",
  plays: [{ batterName: "오스틴", result: "삼진 아웃", type: "strikeout" }],
};
check(
  "terminal relay ignores stale currentBatter",
  resolveCurrentAtBat({ hasRelay: true, latestInning: terminalInning, currentBatter: "오스틴" }) === null,
);

const newBatterInning: InningRelay = {
  ...terminalInning,
  currentAtBat: { batterName: "문보경", pitches: [] },
};
const newAtBat = resolveCurrentAtBat({
  hasRelay: true,
  latestInning: newBatterInning,
  currentBatter: "오스틴",
});
check("relay type:8 batter wins over stale fallback", newAtBat?.batterName === "문보경");
check("relay type:8 zero-pitch card remains visible", newAtBat?.pitches.length === 0);
check(
  "no-relay currentBatter fallback remains",
  resolveCurrentAtBat({ hasRelay: false, latestInning: null, currentBatter: "오스틴" })?.batterName === "오스틴",
);

check("hidden final fetch is skipped", planFinalFetch({ finalFetched: false, visible: false }) === "skip");
check("visible unfetched final retries", planFinalFetch({ finalFetched: false, visible: true }) === "fetch");
check("failed final fetch stays retryable", afterFinalFetch(false, false) === false);
check("successful final fetch latches", afterFinalFetch(false, true) === true);
check("latched final fetch stays skipped", planFinalFetch({ finalFetched: true, visible: true }) === "skip");

console.log(`kgwan live state: ${passed} passed, 0 failed`);
