import assert from "node:assert/strict";
import { fetchPlayerResource } from "../../src/lib/stats/player-resource-client";
const realFetch = globalThis.fetch;
let calls = 0;
let mode = "ok";
const urls: string[] = [];
globalThis.fetch = (async (url) => {
  calls++; urls.push(String(url));
  if (mode === "network") throw new Error("offline");
  return Response.json({ stats: { hits: 12 }, rows: [{ game_id: "20260929" }] }, { status: mode === "http" ? 503 : 200 });
}) as typeof fetch;
async function main() {
  try {
    const responses = await Promise.all(Array.from({ length: 3 }, () => fetchPlayerResource("player-stats", "12345", "투수")));
    assert.equal(calls, 1, "three simultaneous consumers need one network fetch");
    const bodies = await Promise.all(responses.map(r => r.json()));
    assert.deepEqual(bodies[0], bodies[2], "each response body must be independently readable");
    assert.notEqual(responses[0], responses[1]);
    await fetchPlayerResource("player-stats", "12345", "투수");
    assert.equal(calls, 2, "later refresh must fetch again");
    await Promise.all([
      fetchPlayerResource("player-stats", "23456", "투수"),
      fetchPlayerResource("player-stats", "23456", "타자"),
      fetchPlayerResource("player-game-logs", "23456", "타자"),
    ]);
    assert.equal(calls, 5, "player, position and resource keys must remain separate");
    for (const failure of ["network", "http"]) {
      mode = failure;
      const failed = await Promise.allSettled([fetchPlayerResource("player-stats", "12345", "투수"), fetchPlayerResource("player-stats", "12345", "투수")]);
      if (failure === "network") assert.equal(failed[0].status, "rejected");
      else if (failed[0].status === "fulfilled") assert.equal(failed[0].value.status, 503);
      mode = "ok";
      const before = calls;
      assert.equal((await fetchPlayerResource("player-stats", "12345", "투수")).status, 200);
      assert.equal(calls, before + 1, "failure must release in-flight entry");
    }
    assert.ok(urls[0].includes(encodeURIComponent("투수")));
    console.log("PASS: 3-to-1 sharing, independent response bodies, refresh, key isolation, failure recovery");
  } finally { globalThis.fetch = realFetch; }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
