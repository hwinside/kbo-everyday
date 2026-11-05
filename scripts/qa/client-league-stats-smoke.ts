import assert from "node:assert/strict";
import { fetchLeagueStats } from "../../src/lib/stats/client-league-stats";
const realFetch = globalThis.fetch;
let calls = 0;
let mode = "ok";
globalThis.fetch = (async () => {
  calls++;
  if (mode === "network") throw new Error("offline");
  if (mode === "http") return new Response("failure", { status: 503 });
  if (mode === "json") return new Response("invalid");
  return Response.json({ stats: [{ playerName: "Example", rank: 1 }] });
}) as typeof fetch;
async function main() {
  try {
    const a = fetchLeagueStats("batter", 2026);
    assert.equal(a, fetchLeagueStats("batter", 2026));
    const p = fetchLeagueStats("pitcher", 2026);
    const oldSeason = fetchLeagueStats("batter", 2025);
    await Promise.all([a, p, oldSeason]);
    assert.equal(calls, 3, "type/season keys must remain separate");
    await fetchLeagueStats("batter", 2026);
    assert.equal(calls, 4, "settled success must not suppress manual refresh");
    for (const failure of ["network", "http", "json"]) {
      mode = failure;
      const before = calls;
      const first = fetchLeagueStats("batter", 2026);
      const shared = fetchLeagueStats("batter", 2026);
      const results = await Promise.allSettled([first, shared]);
      assert.equal(calls, before + 1, "failed overlapping requests must also share");
      assert.equal(results[0].status, failure === "http" ? "fulfilled" : "rejected");
      mode = "ok";
      await fetchLeagueStats("batter", 2026);
      assert.equal(calls, before + 2, "failure must not poison future requests");
    }
    console.log("PASS: overlapping sharing, type/season isolation, refresh and error recovery");
  } finally { globalThis.fetch = realFetch; }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
