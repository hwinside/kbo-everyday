import assert from "node:assert/strict";
import { test } from "node:test";
import { getNextTicketOpen, KBO_NOTICE_URL } from "../src/lib/utils/ticket-utils";
import { REGULAR_SEASON_WINDOWS, isOutsideConfirmedRegularSeason } from "../src/lib/crawler/naver-games";

for (const [gameId, srId] of [["20251006NCSS0", "4"], ["20251009SSSK0", "3"], ["20251018SSHH0", "5"], ["20251026HHLG0", "7"]]) {
  test(`${gameId}: postseason tickets never fabricate an opening date or provider`, () => {
    const result = getNextTicketOpen([{date: gameId.slice(0,8), srId, homeTeamId: 1}], new Date("2025-10-01T00:00:00+09:00"));
    assert.equal(result?.status, "postseason");
    assert.equal(result?.openAt, null);
    assert.equal(result?.msUntilOpen, null);
    assert.equal(result?.buyUrl, KBO_NOTICE_URL);
  });
}
test("20260729WOLG0: regular-season ticket behavior is preserved", () => {
  const result = getNextTicketOpen([{date: "20260729", srId: "0", homeTeamId: 1}], new Date("2026-07-20T00:00:00+09:00"));
  assert.equal(result?.status, "countdown");
  assert.ok(result?.openAt instanceof Date);
  assert.notEqual(result?.buyUrl, KBO_NOTICE_URL);
});
test("season boundary retains last-day catch-up and unknown years are not silently skipped", () => {
  assert.equal(REGULAR_SEASON_WINDOWS["2026"].finalized, true);
  assert.equal(isOutsideConfirmedRegularSeason("20261012"), false);
  assert.equal(isOutsideConfirmedRegularSeason("20261013"), true);
  assert.equal(isOutsideConfirmedRegularSeason("20270328"), false);
  assert.deepEqual(["20261013", "20261012"].filter(d => !isOutsideConfirmedRegularSeason(d)), ["20261012"]);
});
