/** Exercise the production scan + scheduler with controlled I/O and clock (no network). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startHomeNextGamePoller } from "../../src/lib/polling/home-next-game-poller";

interface Game { id: string }
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function fixture(fetcher: (date: string, signal: AbortSignal) => Promise<Game[]>, initiallyHidden = false) {
  let hidden = initiallyHidden;
  let now = 0;
  let timerId = 0;
  const listeners = new Set<() => void>();
  const timers = new Map<number, { at: number; run: () => void }>();
  const calls: { date: string; signal: AbortSignal }[] = [];
  const results: { game: Game | null; date?: string }[] = [];
  const stop = startHomeNextGamePoller<Game>({
    isHidden: () => hidden,
    onVisibilityChange: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    schedule: (run, ms) => { const id = ++timerId; timers.set(id, { at: now + ms, run }); return id; },
    cancel: (id) => { timers.delete(id); },
    now: () => now,
    dateAtOffset: (offset) => `day-${offset}`,
    fetchGames: (date, signal) => { calls.push({ date, signal }); return fetcher(date, signal); },
    findGame: (games) => games.find((g) => g.id === "match"),
    onResult: (game, date) => { results.push({ game, date }); },
  });
  return {
    calls, results, timers, listeners, stop,
    visibility(value: boolean) { hidden = value; for (const fn of listeners) fn(); },
    async advance(ms: number) {
      const target = now + ms;
      for (let i = 0; i < 100; i++) {
        const next = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].run();
        await flush();
        if (i === 99) throw new Error("unexpected timer loop");
      }
      now = target;
      await flush();
    },
  };
}

async function main() {
  // Hidden mount and elapsed hidden time must not initiate a date scan.
  const visible = fixture(async () => [{ id: "match" }], true);
  await visible.advance(900_000);
  assert.equal(visible.calls.length, 0);
  visible.visibility(false);
  await flush();
  assert.equal(visible.calls.length, 1);
  assert.deepEqual(visible.results[0], { game: { id: "match" }, date: "day-1" });
  await visible.advance(299_999);
  assert.equal(visible.calls.length, 1);
  await visible.advance(1);
  assert.equal(visible.calls.length, 2, "visible start-to-start interval remains five minutes");
  visible.visibility(true);
  await visible.advance(900_000);
  assert.equal(visible.calls.length, 2);
  visible.visibility(false);
  await flush();
  assert.equal(visible.calls.length, 3, "resume starts exactly one scan");
  visible.stop();
  assert.equal(visible.timers.size + visible.listeners.size, 0);

  // A slow scan cannot overlap even when it exceeds the normal interval.
  const slow = deferred<Game[]>();
  const held = fixture(() => slow.promise);
  await held.advance(600_000);
  assert.equal(held.calls.length, 1);
  held.visibility(true);
  assert.equal(held.calls[0].signal.aborted, true);
  slow.resolve([]); // Deliberately ignore AbortSignal to exercise the late-result fence.
  await flush();
  assert.equal(held.calls.length, 1, "hide stops the remaining 13 dates");
  assert.equal(held.results.length, 0, "hide does not clear a card with an incomplete scan");
  held.stop();

  // Rapid hide/resume queues one fresh scan; the aborted result never publishes.
  const stale = deferred<Game[]>();
  let attempts = 0;
  const resumed = fixture(async () => ++attempts === 1 ? stale.promise : [{ id: "match" }]);
  resumed.visibility(true);
  resumed.visibility(false);
  assert.equal(resumed.calls.length, 1);
  stale.resolve([{ id: "match" }]);
  await flush();
  assert.equal(resumed.calls.length, 2);
  assert.equal(resumed.results.length, 1, "only the fresh scan publishes");
  resumed.stop();

  // Cleanup represents unmount, team change, or a newly available today's game.
  const old = deferred<Game[]>();
  const disposed = fixture(() => old.promise);
  disposed.stop();
  assert.equal(disposed.calls[0].signal.aborted, true);
  old.resolve([{ id: "match" }]);
  await disposed.advance(900_000);
  assert.equal(disposed.results.length, 0);
  assert.equal(disposed.calls.length, 1);
  assert.equal(disposed.timers.size + disposed.listeners.size, 0);

  // Keep best-effort date failure handling, first match ordering, and the horizon.
  const next = fixture(async (date) => {
    if (date === "day-1") throw new Error("date unavailable");
    return date === "day-3" ? [{ id: "match" }] : [{ id: "other-team" }];
  });
  await flush();
  assert.deepEqual(next.calls.map((c) => c.date), ["day-1", "day-2", "day-3"]);
  assert.equal(next.results[0].date, "day-3");
  next.stop();
  for (const fail of [false, true]) {
    const empty = fixture(async () => { if (fail) throw new Error("offline"); return []; });
    await flush();
    assert.equal(empty.calls.length, 14);
    assert.equal(empty.calls.at(-1)?.date, "day-14");
    assert.deepEqual(empty.results, [{ game: null, date: undefined }]);
    empty.stop();
  }

  // Production adoption anchors: the tested core must own the real effect and transport.
  const home = readFileSync("src/components/home/HomeClientShell.tsx", "utf8");
  const scan = home.slice(home.indexOf("// 오늘 최애팀 경기가 있으면"), home.indexOf("// 최애선수 목록 →"));
  assert.match(scan, /return startHomeNextGamePoller<HomeGame>\(/);
  assert.match(scan, /fetch\(`\/api\/games\?date=\$\{formatApiDate\(date\)\}`, \{ signal \}\)/);
  assert.doesNotMatch(scan, /setInterval/);
  console.log("home-next-game-poller: PASS (visibility, cadence, single-flight, abort, late results, 14-day fallback, production wiring)");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
