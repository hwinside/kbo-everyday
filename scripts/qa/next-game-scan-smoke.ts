import assert from "node:assert/strict";
import { scanDates, scanNextGame } from "../../src/lib/games/next-game-scan";
import { startHomeNextGamePoller } from "../../src/lib/polling/home-next-game-poller";

async function main() {
  assert.equal(scanDates("20260230", "20260302"), null);
  assert.equal(scanDates("20261009", "20261008"), null);
  assert.equal(scanDates("20261008", "20261023"), null);
  assert.deepEqual(scanDates("20261231", "20270101"), ["20261231", "20270101"]);
  const dates = scanDates("20261009", "20261022")!;
  assert.equal(dates.length, 14);
  const calls: string[] = [];
  const controller = new AbortController();
  const deps = {
    dates, signal: controller.signal,
    fetchGames: async (date: string): Promise<string[]> => { calls.push(date); return []; },
    matches: (game: string) => game === "target",
  };
  assert.deepEqual(await scanNextGame(deps), { game: null, failedDates: [] });
  assert.deepEqual(calls, dates, "no-game scan must cover the full horizon");
  calls.length = 0;
  assert.deepEqual(await scanNextGame({ ...deps, fetchGames: async (date) => {
    calls.push(date);
    if (date === dates[0]) throw new Error("upstream failure");
    return ["cancelled", "target", "later-doubleheader"];
  } }), { game: "target", date: dates[1], failedDates: [dates[0]] });
  assert.deepEqual(calls, dates.slice(0, 2), "stop at first match; preserve within-date order and partial failure");
  calls.length = 0;
  await assert.rejects(scanNextGame({ ...deps, fetchGames: async (date) => {
    calls.push(date); controller.abort(); return ["target"];
  } }));
  assert.equal(calls.length, 1, "abort stops remaining dates even when the current fetch resolves");

  // Production poller batch path, with a controlled clock and no network.
  let hidden = false, now = 0, handler = () => {};
  let batchCalls = 0, dateCalls = 0;
  let timer: (() => void) | undefined;
  let delay = 0;
  const results: (string | null)[] = [];
  let pending: ((result: { game: string | null }) => void) | undefined;
  let signal: AbortSignal | undefined;
  const stop = startHomeNextGamePoller<string>({
    isHidden: () => hidden,
    onVisibilityChange: (fn) => { handler = fn; return () => {}; },
    schedule: (fn, ms) => { timer = fn; delay = ms; return 1; },
    cancel: () => { timer = undefined; }, now: () => now,
    dateAtOffset: (offset) => String(offset),
    fetchGames: async () => { dateCalls++; return []; }, findGame: () => undefined,
    fetchNext: async (s) => { batchCalls++; signal = s; return new Promise((resolve) => { pending = resolve; }); },
    onResult: (game) => results.push(game),
  });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  assert.equal(batchCalls, 1);
  pending!({ game: null }); await flush();
  assert.equal(dateCalls, 0, "batch path must not also run daily scan");
  assert.equal(delay, 300_000);
  now = 300_000; timer!(); await flush();
  assert.equal(batchCalls, 2, "no-game result is refreshed after five minutes");
  hidden = true; handler(); assert.equal(signal!.aborted, true);
  pending!({ game: "late" }); await flush();
  assert.deepEqual(results, [null], "late hidden response cannot publish");
  assert.equal(timer, undefined);
  hidden = false; handler(); await flush(); assert.equal(batchCalls, 3);
  stop(); assert.equal(signal!.aborted, true);
  pending!({ game: "after-stop" }); await flush();
  assert.deepEqual(results, [null]);
  console.log("next-game scan: PASS");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
