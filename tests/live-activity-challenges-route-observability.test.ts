import assert from "node:assert/strict";
import { test } from "node:test";
import Module from "node:module";
import { NextRequest } from "next/server";

test("actual route preserves challenge response and RPC failure when observation fails", async () => {
  const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
  const original = loader._load;
  let saveFails = false;
  let stepFails = false;
  let steps = 0;
  const observations: Record<string, unknown>[] = [];
  loader._load = function(id, ...args) {
    if (id === "@/lib/supabase/admin") return { supabaseAdmin: {
      rpc(name: string, input: Record<string, unknown>) {
        if (name === "live_activity_recovery_step") {
          steps++;
          return Promise.resolve({ data: { challenges: [{ challenge: "qa" }] }, error: stepFails ? {} : null });
        }
        assert.equal(name, "record_live_activity_challenges_request");
        observations.push(input);
        return { abortSignal: async (signal: AbortSignal) => {
          assert.ok(signal instanceof AbortSignal);
          if (saveFails) throw new Error("storage unavailable");
          return { error: null };
        } };
      },
      from() { throw new Error("must not mutate claim or send receipts"); },
    } };
    if (id === "@/lib/notifications/apns") return {
      getProviderTokenSafe() { throw new Error("must not fetch APNs credentials"); },
      sendLiveActivityPushToEnv() { throw new Error("must not send"); },
    };
    return original.call(this, id, ...args);
  };
  try {
    const { POST } = await import("../src/app/api/live-activity/recovery/route");
    const request = () => POST(new NextRequest("https://qa.invalid/api/live-activity/recovery", {
      method: "POST", body: JSON.stringify({ action: "challenges", protocol: 1,
        pushToStartToken: "a".repeat(64), environment: "production" }),
    }));
    assert.deepEqual(await (await request()).json(), { challenges: [{ challenge: "qa" }] });
    saveFails = true;
    assert.deepEqual(await (await request()).json(), { challenges: [{ challenge: "qa" }] });
    stepFails = true;
    assert.equal((await request()).status, 503);
    assert.equal(steps, 3, "no retry of recovery RPC on observation failure");
    assert.equal(observations.length, 3);
    assert.equal(observations[0].p_issued_count, 1);
    assert.equal(observations[2].p_issued_count, null);
    assert.equal(observations[2].p_rpc_failed, true);
  } finally { loader._load = original; }
});
