import { resolveGameLiveDate } from "../../src/lib/game-live-date";

function assert(name: string, condition: boolean) {
  if (!condition) throw new Error(`FAIL: ${name}`);
  console.log(`PASS: ${name}`);
}

const earlyKst = new Date("2026-07-22T17:17:00.000Z");

assert(
  "00:00~08:59 KST defaults to the KST calendar date",
  resolveGameLiveDate(undefined, earlyKst) === "20260723",
);
assert(
  "game detail uses the date encoded in its game id",
  resolveGameLiveDate("20260723NCLG0", new Date("2026-07-24T12:00:00.000Z")) === "20260723",
);
assert(
  "non-KBO ids fall back to the KST calendar date",
  resolveGameLiveDate("pre-2026-07-23-0", earlyKst) === "20260723",
);
