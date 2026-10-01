/** Actual route orchestration: token-scoped APNs only after an atomic claim. */
import assert from "node:assert/strict";
import Module from "node:module";
import { NextRequest } from "next/server";
let claimed = true;
let rpcCalls = 0;
let sends: unknown[][] = [];
const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
const original = loader._load;
loader._load = function(id, ...args) {
  if (id === "@/lib/supabase/admin") return { supabaseAdmin: { rpc: async (_name: string, input: Record<string, unknown>) => {
    rpcCalls++;
    assert.equal(input.p_token, "a".repeat(64));
    assert.equal(input.p_environment, "sandbox");
    return { data: claimed ? { claimed: true, attributes: { gameId: "20261001LGSK0" },
      contentState: { status: "live" }, channelId: "channel-a", attempt: input.p_challenge } : {}, error: null };
  } } };
  if (id === "@/lib/notifications/apns") return {
    getProviderTokenSafe: async () => "qa-provider",
    sendLiveActivityPushToEnv: async (...input: unknown[]) => { sends.push(input); return { ok: true }; },
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
  claimed = false; sends = [];
  await request();
  assert.equal(sends.length, 0, "no atomic claim, no APNs send");
  console.log("PASS real recovery route: fresh report/protocol checks and exact-device start");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
