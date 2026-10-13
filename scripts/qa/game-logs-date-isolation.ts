import assert from "node:assert/strict";
import { collectFinalGamesByDate } from "../../src/lib/game-logs/collect-dates";
import type { KboGame } from "../../src/lib/crawler/kbo-api";

async function main() {
  const final = { gameId: "20261001LGSK0", status: "final" } as KboGame;
  const partial = await collectFinalGamesByDate(["20261002", "20261001"], async (date) => {
    if (date === "20261002") throw new Error("unverified date");
    return [final];
  });
  assert.deepEqual(partial.finals, [final]);
  assert.deepEqual(partial.failedDates, [{ date: "20261002", error: "unverified date" }]);
  const failed = await collectFinalGamesByDate(["20261002", "20261001"], async () => { throw new Error("down"); });
  assert.equal(failed.failedDates.length, 2);
  assert.equal(failed.finals.length, 0);
  const duplicate = await collectFinalGamesByDate(["20261002", "20261001"], async () => [final]);
  assert.equal(duplicate.finals.length, 1);
  assert.equal(duplicate.failedDates.length, 0);
  const empty = await collectFinalGamesByDate(["20261002"], async () => []);
  assert.deepEqual(empty, { finals: [], failedDates: [] });
  console.log("PASS date isolation, all failures, deduplication, verified empty");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
