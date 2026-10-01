import assert from "node:assert/strict";
import { createAutomaticStoryRequest } from "../../src/lib/venue-stories/automatic-request";
import { shouldApplyAutomaticStoryRefresh } from "../../src/lib/venue-stories/refresh-policy";

async function main() {
  const original = globalThis.fetch;
  const calls: Array<{ url: unknown; init?: RequestInit; resolve: (r: Response) => void; reject: (e: Error) => void }> = [];
  globalThis.fetch = ((url, init) => new Promise<Response>((resolve, reject) => {
    calls.push({ url, init, resolve, reject });
  })) as typeof fetch;
  try {
    const client = createAutomaticStoryRequest();
    const url = "/api/venue-stories?gameId=qa-game";
    const epoch = client.epoch();
    const a = client.load(url, "qa-token-A", epoch);
    const b = client.load(url, "qa-token-A", epoch);
    assert.equal(calls.length, 1, "overlapping poll/visible reads share one HTTP request");
    assert.deepEqual(calls[0].init?.headers, { Authorization: "Bearer qa-token-A" });
    calls[0].resolve(Response.json({ stories: [{ id: 1 }] }));
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual(await ra.json(), await rb.json(), "bodies independently consumable");
    const fresh = client.load(url, "qa-token-A", epoch);
    assert.equal(calls.length, 2, "no completed cache; next poll remains fresh");
    calls[1].resolve(Response.json({ stories: [] })); await fresh;

    const old = client.load(url, "qa-token-A", epoch);
    const newEpoch = client.invalidate(); // upload/manual/viewer barrier
    const newer = client.load(url, "qa-token-A", newEpoch);
    const auth = client.load(url, "qa-token-B", newEpoch);
    const guest = client.load(url, undefined, newEpoch);
    const pending = client.load(url + "&statusIds=42", "qa-token-A", newEpoch);
    const game = client.load(url + "2", "qa-token-A", newEpoch);
    assert.equal(calls.length, 8, "manual epoch/auth/game/upload status isolate requests");
    for (const call of calls.slice(2)) call.resolve(Response.json({ stories: [] }));
    await Promise.all([old, newer, auth, guest, pending, game]);
    assert.equal(shouldApplyAutomaticStoryRefresh({ automatic: true, requestId: 1,
      latestRequestId: 2, blocked: false, hidden: false }), false, "older consumer still fenced");
    assert.equal(shouldApplyAutomaticStoryRefresh({ automatic: true, requestId: 2,
      latestRequestId: 2, blocked: false, hidden: false }), true);

    const failed = client.load(url, undefined, client.epoch());
    calls[8].reject(new Error("offline"));
    await assert.rejects(failed);
    const retry = client.load(url, undefined, client.epoch());
    assert.equal(calls.length, 10, "network error releases flight");
    calls[9].resolve(new Response("error", { status: 500 }));
    assert.equal((await retry).status, 500);
    const afterHttpFailure = client.load(url, undefined, client.epoch());
    assert.equal(calls.length, 11, "HTTP error is not cached");
    calls[10].resolve(Response.json({ stories: [] })); await afterHttpFailure;
    console.log("PASS: automatic overlap, no cache, body isolation, epoch/auth/game/status fences, error release");
  } finally { globalThis.fetch = original; }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
