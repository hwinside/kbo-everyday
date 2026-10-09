/** Actual route orchestration: token-scoped APNs only after an atomic claim. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { ApnsResult } from "../../src/lib/notifications/apns";
import Module from "node:module";
import { NextRequest } from "next/server";
let claimed = true;
let result: ApnsResult = { ok: true, status: 200, invalidToken: false, apnsId: "00000000-0000-4000-8000-000000000099" };
let writeError = false;
let sendThrows = false;
let receipt: Record<string, unknown> = {};
let filters: unknown[][] = [];
let writes = 0;
let rpcCalls = 0;
let sends: unknown[][] = [];
const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
const original = loader._load;
loader._load = function(id, ...args) {
  if (id === "@/lib/supabase/admin") return { supabaseAdmin: {
    from: (table: string) => {
      assert.equal(table, "live_activity_device_recovery");
      filters = [];
      const builder = {
        update: (row: Record<string, unknown>) => { writes++; receipt = row; return builder; },
        eq: (...args: unknown[]) => { filters.push(["eq", ...args]); return builder; },
        not: (...args: unknown[]) => { filters.push(["not", ...args]); return builder; },
        is: (...args: unknown[]) => { filters.push(["is", ...args]); return builder; },
        select: () => builder,
        abortSignal: async (signal: AbortSignal) => {
          assert.ok(signal instanceof AbortSignal);
          return { data: writeError ? null : [{ game_id: "20261001LGSK0" }], error: writeError ? {} : null };
        },
      };
      return builder;
    },
    rpc: async (_name: string, input: Record<string, unknown>) => {
    rpcCalls++;
    assert.equal(input.p_token, "a".repeat(64));
    assert.equal(input.p_environment, "sandbox");
    return { data: claimed ? { claimed: true, attributes: { gameId: "20261001LGSK0" },
      contentState: { status: "live" }, channelId: "channel-a", attempt: input.p_challenge } : {}, error: null };
  } } };
  if (id === "@/lib/notifications/apns") return {
    getProviderTokenSafe: async () => "qa-provider",
    sendLiveActivityPushToEnv: async (...input: unknown[]) => { sends.push(input); if (sendThrows) throw new Error("transport private detail"); return result; },
  };
  return original.call(this, id, ...args);
};
async function main() {
  const { POST } = await import("@/app/api/live-activity/recovery/route");
  const body = { protocol: 1, action: "claim", pushToStartToken: "a".repeat(64), environment: "sandbox",
    gameId: "20261001LGSK0", channelId: "channel-a", challenge: "00000000-0000-4000-8000-000000000001", noCard: true };
  const request = (patch: Record<string, unknown> = {}) => POST(new NextRequest("https://qa.invalid/api/live-activity/recovery", {
    method: "POST", body: JSON.stringify({ ...body, ...patch }),
  }));
  assert.equal((await request({ protocol: undefined })).status, 400, "old native version");
  assert.equal((await request({ noCard: false })).status, 400, "existing card cannot restart");
  assert.equal((await request({ challenge: undefined })).status, 400, "no report cannot restart");
  assert.equal(rpcCalls, 0);
  await request();
  assert.equal(sends.length, 1);
  const [push, env] = sends[0] as [{ pushToken: string; event: string; inputPushChannel: string; attributes: { recoveryAttempt: string } }, string];
  assert.equal(push.pushToken, body.pushToStartToken);
  assert.equal(env, "sandbox");
  assert.equal(push.event, "start");
  assert.equal(push.inputPushChannel, body.channelId);
  assert.equal(push.attributes.recoveryAttempt, body.challenge);
  assert.equal(receipt.restart_apns_outcome, "accepted");
  assert.equal(receipt.restart_apns_status, 200);
  assert.equal(receipt.restart_apns_id, result.apnsId);
  assert.deepEqual(filters, [
    ["eq", "game_id", body.gameId],
    ["eq", "device_key", createHash("sha256").update(body.pushToStartToken).digest("hex")],
    ["eq", "environment", body.environment], ["eq", "channel_id", body.channelId],
    ["eq", "challenge", body.challenge], ["not", "restart_at", "is", null],
    ["is", "restart_apns_recorded_at", null],
  ]);
  assert.equal("ack_at" in receipt, false);
  assert.equal("restart_at" in receipt, false);
  result = { ok: false, status: 410, reason: "Unregistered", invalidToken: true };
  assert.deepEqual(await (await request()).json(), { accepted: false });
  assert.equal(receipt.restart_apns_outcome, "rejected");
  assert.equal(receipt.restart_apns_reason, "Unregistered");
  result = { ok: false, status: 0, reason: "timeout", invalidToken: false };
  await request();
  assert.equal(receipt.restart_apns_outcome, "unknown");
  result.reason = "secret-token-in-url";
  result.apnsId = "private-value";
  await request();
  assert.equal(receipt.restart_apns_reason, "unclassified_error");
  assert.equal(receipt.restart_apns_id, null);
  sendThrows = true;
  await assert.rejects(() => request(), /transport private detail/);
  assert.equal(receipt.restart_apns_reason, "send_threw");
  sendThrows = false;
  writeError = true;
  result = { ok: true, status: 200, invalidToken: false };
  const countBefore = sends.length;
  assert.deepEqual(await (await request()).json(), { accepted: true });
  assert.equal(sends.length, countBefore + 1, "persistence error never retries APNs");
  const writesBefore = writes;
  claimed = false; sends = [];
  await request();
  assert.equal(sends.length, 0, "no atomic claim, no APNs send");
  assert.equal(writes, writesBefore, "no claim, no receipt write");
  console.log("PASS real recovery route: fresh report/protocol checks and exact-device start");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
