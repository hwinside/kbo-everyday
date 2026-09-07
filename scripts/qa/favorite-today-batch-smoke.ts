/** Production batch core/transport contracts. Offline; execution belongs to reviewer. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  collectTodayGameBatch,
  fetchTodayGameBatch,
  MAX_TODAY_GAME_BATCH,
  parseTodayGameBatch,
  type TodayGameBatchPlayer,
} from "../../src/lib/player-today-game-batch";
import { MAX_FAVORITES } from "../../src/lib/profile/favorite-players-validation";
import type { PlayerTodayGameResponse } from "../../src/lib/services/player-today-game";

const players: TodayGameBatchPlayer[] = [
  { playerId: "A", teamId: 1, name: "선수A", pos: "타자" },
  { playerId: "B", teamId: 2, name: "선수B", pos: "투수" },
  { playerId: "C", teamId: 3, name: "선수C", pos: "타자" },
];
const body = (p: TodayGameBatchPlayer): PlayerTodayGameResponse => ({
  show: true, status: "live", isLive: true,
  opponentName: p.playerId, type: p.pos === "투수" ? "pitcher" : "batter",
});
const result = (p: TodayGameBatchPlayer, policy = "s-maxage=20, stale-while-revalidate=40") => ({
  body: body(p), headers: { "Cache-Control": policy },
});
let passed = 0;
function check(name: string, run: () => void) {
  run();
  passed++;
  console.log(`PASS ${name}`);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function main() {
  check("batch bound matches saved favorites", () => assert.equal(MAX_TODAY_GAME_BATCH, MAX_FAVORITES));
  check("valid request preserves the old team/name/position tuple", () =>
    assert.deepEqual(parseTodayGameBatch(JSON.stringify(players)), players));
  check("malformed/unbounded/duplicate requests rejected before loader", () => {
    for (const raw of [null, "{", "{}", "[]", "x".repeat(2049), JSON.stringify([...players, ...players]),
      JSON.stringify([players[0], players[0]])]) assert.equal(parseTodayGameBatch(raw), null);
    for (const invalid of [
      { ...players[0], teamId: 11 }, { ...players[0], teamId: 1.5 },
      { ...players[0], name: " " }, { ...players[0], name: "x".repeat(65) },
      { ...players[0], playerId: "x".repeat(65) }, { ...players[0], pos: "catcher" },
      { ...players[0], playerId: 42 },
    ]) assert.equal(parseTodayGameBatch(JSON.stringify([invalid])), null);
  });
  check("all five favorites are accepted", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ ...players[0], playerId: `P${i}` }));
    assert.equal(parseTodayGameBatch(JSON.stringify(five))?.length, 5);
  });

  const calls: string[] = [];
  const pending = players.map(() => deferred<ReturnType<typeof result>>());
  const flight = collectTodayGameBatch(players, (p) => {
    calls.push(p.playerId);
    return pending[players.indexOf(p)].promise;
  }, () => 0);
  pending[2].resolve(result(players[2]));
  pending[0].resolve(result(players[0]));
  pending[1].resolve(result(players[1]));
  const all = await flight;
  check("one direct service call per player; out-of-order results retain identity", () => {
    assert.deepEqual(calls, ["A", "B", "C"]);
    for (const p of players) assert.deepEqual(all.body.items[p.playerId], body(p));
  });
  check("unchanged data and no extra stale lifetime", () => {
    assert.equal(all.headers["Cache-Control"], "public, max-age=0, s-maxage=20, must-revalidate");
  });

  const partial = await collectTodayGameBatch(players, async (p) => {
    if (p.playerId === "B") throw new Error("one upstream failed");
    return result(p);
  }, () => 0);
  check("one thrown player failure retains peers and disables aggregate caching", () => {
    assert.equal(partial.body.items.B, null);
    assert.deepEqual(partial.body.items.A, body(players[0]));
    assert.deepEqual(partial.body.items.C, body(players[2]));
    assert.match(partial.headers["Cache-Control"], /no-store/);
  });
  const httpFailure = await collectTodayGameBatch(players, async (p) =>
    p.playerId === "B" ? { ...result(p), status: 503 } : result(p), () => 0);
  check("per-item HTTP error is isolated even when Promise fulfilled", () => {
    assert.equal(httpFailure.body.items.B, null);
    assert.deepEqual(httpFailure.body.items.A, body(players[0]));
    assert.match(httpFailure.headers["Cache-Control"], /no-store/);
  });
  for (const policy of ["no-store", "public", "private, s-maxage=20", "s-maxage=300"]) {
    const mixed = await collectTodayGameBatch(players, async (p) => result(p, p.playerId === "B" ? policy : undefined), () => 0);
    check(`unsafe/unknown policy ${policy} disables cache but retains data`, () => {
      assert.match(mixed.headers["Cache-Control"], /no-store/);
      assert.deepEqual(mixed.body.items.B, body(players[1]));
    });
  }
  for (const header of ["Set-Cookie", "Vary", "Vercel-CDN-Cache-Control", "CDN-Cache-Control", "Cloudflare-CDN-Cache-Control"]) {
    const mixed = await collectTodayGameBatch([players[0]], async (p) => ({
      ...result(p), headers: { ...result(p).headers, [header]: "no-store" },
    }), () => 0);
    check(`${header} cannot be silently discarded into a public cache`, () => assert.match(mixed.headers["Cache-Control"], /no-store/));
  }
  const hidden = await collectTodayGameBatch(players, async (p) => ({
    ...result(p, "s-maxage=60"), body: { ...body(p), show: false, status: "scheduled" as const },
  }), () => 0);
  check("scheduled/hidden result remains hidden with its 60s bound", () => {
    assert.equal(hidden.body.items.A?.show, false);
    assert.match(hidden.headers["Cache-Control"], /s-maxage=60,/);
  });

  let clock = 0;
  const slow = deferred<ReturnType<typeof result>>();
  const ageingFlight = collectTodayGameBatch(players.slice(0, 2), async (p) =>
    p.playerId === "A" ? result(p) : slow.promise, () => clock);
  await Promise.resolve();
  await Promise.resolve();
  clock = 1500;
  slow.resolve(result(players[1], "s-maxage=60"));
  const ageing = await ageingFlight;
  check("slow sibling consumes earlier item's TTL instead of restarting it", () =>
    assert.equal(ageing.headers["Cache-Control"], "public, max-age=0, s-maxage=18, must-revalidate"));

  const prototype = await collectTodayGameBatch([{ ...players[0], playerId: "__proto__" }], async (p) => result(p), () => 0);
  check("IDs are data keys, not object prototype mutations", () => {
    assert.equal(Object.getPrototypeOf(prototype.body.items), null);
    assert.equal(JSON.parse(JSON.stringify(prototype.body)).items.__proto__.opponentName, "__proto__");
  });

  const urls: string[] = [];
  const transport: typeof fetch = async (input) => {
    urls.push(String(input));
    return Response.json({ items: { ...all.body.items, EXTRA: body(players[0]) } });
  };
  const fetched = await fetchTodayGameBatch(players, transport);
  check("three players create one HTTP request, not three", () => {
    assert.equal(urls.length, 1);
    assert.match(urls[0], /^\/api\/player-today-game\/batch\?/);
    assert.deepEqual(Object.keys(fetched).sort(), ["A", "B", "C"]);
  });
  await fetchTodayGameBatch([...players].reverse(), transport);
  check("reordering favorites reuses the same URL/cache key", () => assert.equal(urls[0], urls[1]));
  await fetchTodayGameBatch([], transport);
  check("empty favorites create zero HTTP requests", () => assert.equal(urls.length, 2));
  for (const response of [new Response("", { status: 503 }), new Response("{"), Response.json({ items: [] })]) {
    let attempts = 0;
    const failure = await fetchTodayGameBatch(players, async () => { attempts++; return response; });
    check("batch failure does not fall back to per-player request fanout", () => {
      assert.equal(attempts, 1);
      assert.deepEqual(failure, {});
    });
  }
  const route = readFileSync("src/app/api/player-today-game/batch/route.ts", "utf8");
  const ui = readFileSync("src/components/home/FavoritePlayersSection.tsx", "utf8");
  check("production route binds direct service and deferred effects; UI uses batch transport", () => {
    assert.match(route, /collectTodayGameBatch\(players, \(player\) => getPlayerTodayGameRouteResult\(/);
    assert.match(route, /after\(\(\) => effect\(\)\)/);
    assert.doesNotMatch(route, /\bfetch\s*\(/);
    assert.match(ui, /await fetchTodayGameBatch\(favPlayers\.map/);
    assert.doesNotMatch(ui, /\/api\/player-today-game\?/);
  });
  console.log(`favorite-today-batch: ${passed} contracts passed`);
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
