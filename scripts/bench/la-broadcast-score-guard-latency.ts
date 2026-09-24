/** Actual broadcast pass with local injected RPC latency; not APNs/device QA.
 * Run: npx tsx scripts/bench/la-broadcast-score-guard-latency.ts
 */
import assert from "node:assert/strict";
import { runChannelBroadcastPass } from "../../src/lib/notifications/live-activity-channel-broadcast-pass";
import type { ChannelRow } from "../../src/lib/notifications/live-activity-channels";
import type { KboRawGame } from "../../src/types/api";

async function main() {
  const now = Date.now();
  const games = Array.from({ length: 10 }, (_, i) => ({
    G_ID: String(i), GAME_STATE_SC: "2", CANCEL_SC_ID: "0",
  } as KboRawGame));
  const channels = games.map((g) => ({
    game_id: g.G_ID, environment: "production", channel_id: `test-${g.G_ID}`,
    status: "active", last_score_state: "1|0|3|true|false|false|false|live",
    last_state_hash: "old", last_p10_at: new Date(now).toISOString(),
    last_send_at: new Date(now).toISOString(), created_at: new Date(now).toISOString(),
    last_content_state: null, attempt_count: 0, next_retry_at: null, ending_at: null,
  } as ChannelRow));
  for (const delayMs of [20, 1500]) {
    let active = 0, peak = 0, calls = 0, sent = 0;
    const deps = {
      now: () => Date.now(), gameStatus: () => "live" as const,
      buildContentState: () => ({ awayScore: 1, homeScore: 1, inning: 3,
        isTopInning: true, status: "live", onFirst: false, onSecond: false, onThird: false }),
      observeScoreGuard: async () => {
        calls++; peak = Math.max(peak, ++active);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        active--;
        return { allowCorrection: false, blockedCount: 0, blockedMs: 0 };
      },
      send: async () => { sent++; return { ok: true }; },
      deleteChannel: async () => true, updateChannel: async () => 1,
    };
    const start = performance.now();
    const result = await runChannelBroadcastPass(channels, games, undefined, {}, deps);
    const elapsedMs = Math.round(performance.now() - start);
    assert.equal(calls, 10); assert.equal(peak, 10);
    assert.equal(result.updates, 10); assert.equal(sent, 10);
    assert.ok(elapsedMs < (delayMs === 1500 ? 2500 : 1000));
    console.log(JSON.stringify({ path: "broadcast", channels: 10, delayMs, elapsedMs, peak, calls, sent }));

    // Two environments share only identical baselines; a lagging baseline stays separate.
    calls = 0;
    await runChannelBroadcastPass([channels[0], { ...channels[0], environment: "sandbox" },
      { ...channels[0], last_score_state: "0|0|3|true|false|false|false|live" }], games, undefined, {}, deps);
    assert.equal(calls, 2);
    calls = 0; sent = 0;
    const expired = await runChannelBroadcastPass(channels, games, undefined,
      { deadlineAtMs: Date.now() - 1 }, deps);
    assert.equal(calls, 0); assert.equal(sent, 0); assert.equal(expired.deadlineSkipped, 10);
    assert.equal(expired.failedGameIds.length, 10);
    const during = await runChannelBroadcastPass(channels, games, undefined,
      { deadlineAtMs: Date.now() + Math.max(1, Math.floor(delayMs / 2)) }, deps);
    assert.equal(sent, 0); assert.equal(during.deadlineSkipped, 10);
    assert.equal(during.failedGameIds.length, 10);
  }
  console.log("broadcast latency/dedup/baseline isolation/deadline self-check complete (not independent QA)");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
