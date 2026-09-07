import assert from "node:assert/strict";
import { canEdit, textLength, validateText, EDIT_WINDOW_MS } from "../src/lib/game-reviews/domain";
import { gameTeams, reviewContext } from "../src/lib/game-reviews/context";
import type { GameDetailResponse, BatterRecord, PitcherRecord } from "../src/lib/services/game-detail";

const family = "👨‍👩‍👧‍👦";
assert.equal(textLength(family + "🇰🇷" + "가"), 3);
assert.equal(validateText(family.repeat(100)), family.repeat(100));
assert.throws(() => validateText(family.repeat(101)));
assert.throws(() => validateText(" \n\u200d "));
assert.throws(() => validateText({ text: "hello" }));
assert.throws(() => validateText("시 발"));
assert.equal(validateText("팬의 한 줄\r\n\n응원해요"), "팬의 한 줄\n\n응원해요");
const created = "2026-09-07T10:00:00.000Z", epoch = Date.parse(created);
assert.equal(canEdit(created, 0, epoch + EDIT_WINDOW_MS - 1), true);
assert.equal(canEdit(created, 0, epoch + EDIT_WINDOW_MS), false);
assert.equal(canEdit(created, 1, epoch), false);
assert.equal(canEdit(created, 0, epoch - 1), false);
assert.deepEqual(gameTeams("20260907SSLG0"), [8, 1]);
for (const bad of ["20260907SSLG02026", "20260907LGLG0", "20260907XXXX0"]) assert.throws(() => gameTeams(bad));
const batter = (name: string, order: number): BatterRecord => ({ name, order, position: "DH", positionFull: "지명타자", atBats: 1, hits: 1, runs: 0, rbi: 0, hr: 0, h2b: 0, h3b: 0, bb: 0, so: 0, sb: 0, avg: "1.000", isSubstitute: false });
const pitcher = (name: string): PitcherRecord => ({ name, inningsPitched: "1", decision: "", pitchCount: 10, hits: 0, runs: 0, hr: 0, strikeouts: 1, walks: 0, earnedRuns: 0, battersFaced: 3, atBats: 3, era: "0.00" });
const detail: GameDetailResponse = { gameId: "20260907SSLG0", status: "final", meta: null, lineup: null,
  linescore: { away: { innings: [], R: 3, H: 5, E: 0 }, home: { innings: [], R: 4, H: 6, E: 0 } },
  boxScore: { awayBatters: [batter("상대 선수", 1)], awayPitchers: [], homeBatters: [batter("승리 선수", 4)], homePitchers: [pitcher("승리 투수")] },
};
let context = reviewContext(detail.gameId, detail);
assert.equal(context.winnerTeamId, 1);
assert.deepEqual(context.players.map(p => p.name), ["승리 선수", "승리 투수"]);
assert.equal(context.players[0].key, "b:4:승리 선수");
context = reviewContext(detail.gameId, { ...detail, linescore: { ...detail.linescore!, home: { ...detail.linescore!.home, R: 3 } } });
assert.equal(context.winnerTeamId, null); assert.deepEqual(context.players, []);
assert.deepEqual(reviewContext(detail.gameId, { ...detail, boxScore: null }).players, []);
for (const status of ["scheduled", "live", "cancelled"] as const) assert.equal(reviewContext(detail.gameId, { ...detail, status }).final, false);
console.log("Game-review domain checks passed: graphemes, filter, exact edit deadline, game IDs, winner/participant and non-final boundaries.");
