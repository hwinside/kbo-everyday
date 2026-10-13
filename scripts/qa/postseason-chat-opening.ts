import assert from "node:assert/strict";
import { gameChatOpensAt } from "../../src/lib/game-chat-opening";
const start = new Date("2026-10-14T18:30:00+09:00");
for (const srId of ["3", "4", "5", "7"]) {
  const open = gameChatOpensAt(start, srId)!.getTime();
  assert.equal(open, Date.parse("2026-10-13T18:30:00+09:00"));
  assert.equal(Date.parse("2026-10-13T18:29:59+09:00") >= open, false);
  assert.equal(Date.parse("2026-10-13T18:30:00+09:00") >= open, true);
}
for (const srId of ["0", "1", "9", undefined]) {
  assert.equal(gameChatOpensAt(start, srId)!.getTime(), Date.parse("2026-10-14T16:30:00+09:00"));
}
assert.equal(gameChatOpensAt(null, "4"), null);
assert.equal(gameChatOpensAt(new Date("invalid"), "4"), null);
assert.equal(gameChatOpensAt(new Date("2026-11-01T14:00:00+09:00"), "7")!.getTime(), Date.parse("2026-10-31T14:00:00+09:00"));
console.log("postseason-chat-opening PASS: all rounds, exact boundary, regular/unknown, missing time, month rollover");
