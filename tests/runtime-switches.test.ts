import assert from "node:assert/strict";
import test from "node:test";
import { isFeatureDisabled, resetFeatureSwitchCache, SWITCH_TTL_MS } from "../src/lib/config/runtime-switches";

// The switch exists to stop a feature mid-game, so these are the cases that matter.
test("runtime feature switches", async (t) => {
  await t.test("only an explicit off value disables the feature", async () => {
    for (const raw of ["off", "OFF", " off ", "0", "false", "disabled"]) {
      resetFeatureSwitchCache();
      assert.equal(await isFeatureDisabled("relay-events", { command: async () => raw }), true, String(raw));
    }
    for (const raw of [null, "", "on", "1", "true", "yes", 0, undefined]) {
      resetFeatureSwitchCache();
      assert.equal(await isFeatureDisabled("relay-events", { command: async () => raw }), false, String(raw));
    }
  });

  await t.test("a store outage keeps the feature on", async () => {
    resetFeatureSwitchCache();
    const command = async () => { throw new Error("store down"); };
    assert.equal(await isFeatureDisabled("game-summary", { command }), false);
  });

  await t.test("reads are cached within the TTL and re-read after it", async () => {
    resetFeatureSwitchCache();
    let calls = 0;
    const command = async () => { calls++; return "off"; };
    assert.equal(await isFeatureDisabled("relay-events", { command, nowMs: 1000 }), true);
    assert.equal(await isFeatureDisabled("relay-events", { command, nowMs: 1000 + SWITCH_TTL_MS - 1 }), true);
    assert.equal(calls, 1, "a read inside the TTL must not hit the store");
    assert.equal(await isFeatureDisabled("relay-events", { command, nowMs: 1000 + SWITCH_TTL_MS }), true);
    assert.equal(calls, 2, "TTL expiry must re-read so an operator can switch the feature back on");
  });

  await t.test("each feature has its own key", async () => {
    resetFeatureSwitchCache();
    const seen: string[] = [];
    const command = async (args: (string | number)[]) => {
      const key = String(args[1]);
      seen.push(key);
      return key.endsWith("relay-events") ? "off" : "on";
    };
    assert.equal(await isFeatureDisabled("relay-events", { command }), true);
    assert.equal(await isFeatureDisabled("game-summary", { command }), false);
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0], seen[1]);
  });
});
