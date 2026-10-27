import assert from "node:assert/strict";
import { test } from "node:test";
import { RelayUpstreamError, RelayUpstreamGate } from "../src/lib/game/relay-upstream-gate";

const unavailable = () => new RelayUpstreamError(503, { error: "relay_upstream_timeout" });

test("burst shares one failure, cooldown polls do not slide expiry, recovery retries once", async () => {
  let now = 0;
  let calls = 0;
  const gate = new RelayUpstreamGate<string>(() => now);
  const failure = unavailable();
  const build = async () => { calls++; throw failure; };
  const burst = await Promise.allSettled(Array.from({ length: 100 }, () => gate.run("ks-1", build)));
  assert.equal(calls, 1);
  assert.ok(burst.every(r => r.status === "rejected" && r.reason === failure));
  assert.equal(gate.retryAfterSeconds("ks-1"), 5);
  for (now = 1000; now < 5000; now += 1000) {
    await assert.rejects(gate.run("ks-1", build), e => e === failure);
    assert.equal(gate.retryAfterSeconds("ks-1"), 5 - now / 1000);
  }
  assert.equal(calls, 1);
  assert.equal(gate.retryAfterSeconds("ks-1"), 0);
  const recovered = await Promise.all(Array.from({ length: 100 }, () => gate.run("ks-1", async () => { calls++; return "fresh"; })));
  assert.ok(recovered.every(v => v === "fresh"));
  assert.equal(calls, 2);
  assert.equal(await gate.run("ks-1", async () => "newer"), "newer");
});

test("different game/hint keys remain independent and degraded successes are not cached", async () => {
  const gate = new RelayUpstreamGate<{ degraded: boolean }>();
  await assert.rejects(gate.run("ks-1", async () => { throw unavailable(); }));
  for (const key of ["ks-9", "other-1"]) {
    assert.deepEqual(await gate.run(key, async () => ({ degraded: true })), { degraded: true });
    assert.deepEqual(await gate.run(key, async () => ({ degraded: false })), { degraded: false });
  }
});

test("unknown internal failures are shared but not retained", async () => {
  const gate = new RelayUpstreamGate<number>();
  await assert.rejects(gate.run("a", async () => { throw new TypeError("bug"); }), TypeError);
  assert.equal(gate.retryAfterSeconds("a"), 0);
  assert.equal(await gate.run("a", async () => 42), 42);
});

test("failure key storage is bounded and a repeated outage rearms only after a new attempt", async () => {
  let now = 0;
  const gate = new RelayUpstreamGate<number>(() => now);
  for (let i = 0; i <= 256; i++) {
    await assert.rejects(gate.run(String(i), async () => { throw unavailable(); }));
  }
  assert.equal(await gate.run("0", async () => 42), 42);
  assert.equal(gate.retryAfterSeconds("256"), 5);
  now = 5000;
  await assert.rejects(gate.run("256", async () => { throw unavailable(); }));
  assert.equal(gate.retryAfterSeconds("256"), 5);
});
