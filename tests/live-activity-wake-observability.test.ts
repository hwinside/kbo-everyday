import assert from "node:assert/strict";
import { test } from "node:test";
import { observeSafely, wakeReceipts } from "../src/lib/notifications/live-activity-wake-observability";

test("joins only matching users, preserves each game/device, deduplicates and never stores tokens", () => {
  const rows = wakeReceipts([
    { user_id: "a", game_id: "g1" }, { user_id: "a", game_id: "g1" },
    { user_id: "a", game_id: "g2" }, { user_id: "b", game_id: "g3" },
  ], [{ user_id: "a", fcm_token: "private-token-one" }, { user_id: "b", fcm_token: "private-token-two" }], [
    { token: "private-token-one", status: "accepted", errorCode: null },
    { token: "private-token-two", status: "invalid", errorCode: "messaging/registration-token-not-registered" },
  ], "invocation", "time");
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((r) => r.outcome === "accepted").length, 2);
  assert.equal(rows.find((r) => r.user_id === "b")!.outcome, "rejected");
  assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.fcm_token_hash)));
  assert.ok(!JSON.stringify(rows).includes("private-token"));
});

test("missing and thrown transport outcomes are unknown; raw exception text cannot leak", () => {
  const rows = wakeReceipts([{ user_id: "a", game_id: "g" }], [
    { user_id: "a", fcm_token: "secret" }, { user_id: "a", fcm_token: "missing" },
  ], [{ token: "secret", status: "transient", errorCode: "transport secret" }], "id", "time");
  assert.deepEqual(rows.map((r) => r.outcome), ["unknown", "unknown"]);
  assert.ok(!JSON.stringify(rows).includes("secret"));
});

test("failed persistence is swallowed exactly once with no retry", async () => {
  let attempts = 0;
  await observeSafely(async () => { attempts++; throw new Error("DB down"); });
  assert.equal(attempts, 1);
});
