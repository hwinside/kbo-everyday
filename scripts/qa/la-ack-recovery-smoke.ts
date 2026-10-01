/** Exercise the real silent-wake entrypoint with isolated DB/FCM adapters.
 * This does not claim PostgreSQL concurrency or iOS delivery verification.
 */
import assert from "node:assert/strict";
import Module from "node:module";
import type { KboRawGame } from "@/types/api";

const gameId = "20261001LGSK0";
const now = Date.now();
let claimed = false;
let acknowledged = false;
let failClaim = false;
let sends = 0;
let mutations = 0;
const started = {
  user_id: "qa-user", game_id: gameId,
  created_at: new Date(now - 180_000).toISOString(),
  channel_born_environment: "production", channel_born_channel_id: "qa-channel",
  ack_recovery_attempted_at: null,
};
const channel = { game_id: gameId, environment: "production", channel_id: "qa-channel", created_at: started.created_at };
function query(table: string) {
  let patch: Record<string, unknown> | undefined;
  const q = {
    select: () => q, eq: () => q, in: () => q, is: () => q,
    order: () => q, limit: () => q, gt: () => q,
    update: (v: Record<string, unknown>) => { patch = v; return q; },
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      let data: unknown[] = [];
      let error: { message: string } | null = null;
      if (patch && table === "live_activity_started_users") {
        if (patch.ack_recovery_attempted_at) {
          mutations++;
          if (failClaim) error = { message: "injected claim failure" };
          else if (!claimed) { claimed = true; data = [{ user_id: started.user_id }]; }
        }
      } else if (table === "live_activity_started_users") {
        // Deliberately stale reads for both concurrent workers. CAS must arbitrate.
        data = [{ ...started }];
      } else if (table === "live_activity_channels") data = [channel];
      else if (table === "live_activity_channel_subscriptions" && acknowledged) {
        data = [{ ...channel, user_id: started.user_id, device_key: "qa-device" }];
      }
      return Promise.resolve({ data, error }).then(resolve, reject);
    },
  };
  return q;
}
const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
const original = loader._load;
loader._load = function (id, ...args) {
  if (id === "@/lib/supabase/admin") return { supabaseAdmin: { from: query } };
  if (id === "@/lib/notifications/fcm") return { sendFcmToUsers: async () => {
    sends++;
    return { sent: 1, failed: 0, skipped: 0, cleaned: 0, ok: true };
  } };
  return original.call(this, id, ...args);
};
async function main() {
  try {
    const { pushLiveActivitySilentWakes } = await import("@/lib/notifications/live-activity");
    const games = [{ G_ID: gameId, GAME_STATE_SC: "1", CANCEL_SC_ID: "0" }] as KboRawGame[];
    await Promise.all([pushLiveActivitySilentWakes(games), pushLiveActivitySilentWakes(games)]);
    assert.equal(sends, 1, "two stale readers must emit only one recovery wake");
    await pushLiveActivitySilentWakes(games);
    assert.equal(sends, 1, "persisted claim caps later ticks");
    claimed = false; acknowledged = true; mutations = 0;
    await pushLiveActivitySilentWakes(games);
    assert.equal(mutations, 0, "ACK must stop recovery before claim");
    assert.equal(sends, 1);
    acknowledged = false; failClaim = true;
    const result = await pushLiveActivitySilentWakes(games);
    assert.ok("error" in result, "claim failure must be observable");
    assert.equal(sends, 1, "claim failure must not send");
    console.log("PASS: real wake entrypoint concurrent stale reads, cap, ACK stop, claim failure (mock adapters)");
  } finally { loader._load = original; }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
