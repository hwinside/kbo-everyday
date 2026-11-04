import "../scripts/qa/_smoke-env";
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { deliverTokenChunks, type FcmChunkResponse } from "../src/lib/notifications/fcm-batch";
import { pushAndroidWidgetLiveUpdates, type AndroidWidgetPushDeps } from "../src/lib/notifications/android-widget-live";
import type { KboRawGame } from "../src/types/api";

const accepted = (tokens: string[]): FcmChunkResponse => ({ successCount: tokens.length, failureCount: 0, responses: tokens.map(() => ({})) });
const tokens = Array.from({ length: 2300 }, (_, i) => String(i));

test("2300 tokens start five chunks concurrently and aggregate in input order", async () => {
  let active = 0;
  let peak = 0;
  const result = await deliverTokenChunks(tokens, async (chunk) => {
    peak = Math.max(peak, ++active);
    await delay(6 - Number(chunk[0]) / 500);
    active -= 1;
    return accepted(chunk);
  }, 500, { concurrency: 5 });
  assert.equal(peak, 5);
  assert.equal(active, 0);
  assert.equal(result.sent, 2300);
  assert.deepEqual(result.outcomes.map(o => o.token), tokens);
});

test("deadline prevents later waves; started requests are fully awaited", async () => {
  let now = 0;
  let calls = 0;
  const result = await deliverTokenChunks(Array.from({ length: 3300 }, (_, i) => String(i)), async chunk => {
    calls += 1;
    await delay(1);
    now = 10;
    return accepted(chunk);
  }, 500, { concurrency: 5, deadlineAtMs: 10, now: () => now });
  assert.equal(calls, 5);
  assert.equal(result.sent, 2500);
  assert.equal(result.failed, 800);
  assert.equal(result.retryableFailed, 800);
  assert.equal(result.lastError, "deadline_exceeded");
  assert.equal(result.outcomes.length, 3300);
});

test("deadline is rechecked between launches in the same wave", async () => {
  let now = 0;
  let calls = 0;
  const result = await deliverTokenChunks(tokens, async chunk => {
    calls += 1;
    now = 10;
    return accepted(chunk);
  }, 500, { concurrency: 5, deadlineAtMs: 10, now: () => now });
  assert.equal(calls, 1);
  assert.equal(result.sent, 500);
  assert.equal(result.retryableFailed, 1800);
});

test("mixed exceptions and token errors preserve classification and ordered results", async () => {
  const result = await deliverTokenChunks(["ok", "throw", "invalid", "transient", "permanent"], async chunk => {
    if (chunk[0] === "throw") throw new Error("transport");
    const code = ({ invalid: "messaging/registration-token-not-registered", transient: "messaging/server-unavailable", permanent: "messaging/third-party-auth-error" } as Record<string, string>)[chunk[0]];
    return code ? { successCount: 0, failureCount: 1, responses: [{ error: { code } }] } : accepted(chunk);
  }, 1, { concurrency: 5 });
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 4);
  assert.equal(result.retryableFailed, 2);
  assert.equal(result.ok, false);
  assert.deepEqual(result.invalid, ["invalid"]);
  assert.deepEqual(result.outcomes.map(o => o.status), ["accepted", "transient", "invalid", "transient", "permanent_failed"]);
});

test("default stays serial and invalid concurrency is rejected", async () => {
  let active = 0;
  let peak = 0;
  await deliverTokenChunks(tokens, async chunk => {
    peak = Math.max(peak, ++active);
    await delay(1);
    active -= 1;
    return accepted(chunk);
  });
  assert.equal(peak, 1);
  await assert.rejects(deliverTokenChunks(tokens, async c => accepted(c), 500, { concurrency: 6 }));
});

const game = { G_ID: "20261104SSKT0", GAME_STATE_SC: "2", AWAY_NM: "삼성", HOME_NM: "KT", T_SCORE_CN: "1", B_SCORE_CN: "0", GAME_INN_NO: "2", GAME_TB_SC: "T", OUT_CN: "1" } as unknown as KboRawGame;

test("healthy relay retains last play; expired absolute deadline starts no work", async () => {
  let fetches = 0;
  let sends = 0;
  const deps: AndroidWidgetPushDeps = {
    fetchImpl: (async () => {
      fetches += 1;
      return new Response(JSON.stringify({ innings: [{ plays: [{ batterName: "타자", result: "안타" }] }] }));
    }) as typeof fetch,
    fansOfTeamsImpl: async () => ({ ids: ["fan"], ok: true }),
    sendFcmImpl: async (_ids, payload) => {
      sends += 1;
      assert.equal(payload.data?.w_lastplay, "타자 안타");
      return { tokens: 1, sent: 1, failed: 0, cleaned: 0, skipped: 0, ok: true };
    },
  };
  await pushAndroidWidgetLiveUpdates([game], "https://test.invalid", {}, deps);
  await pushAndroidWidgetLiveUpdates([game], "https://test.invalid", { deadlineAtMs: Date.now() - 1 }, deps);
  assert.equal(fetches, 1);
  assert.equal(sends, 1);
});

for (const phase of ["headers", "body"] as const) {
  test(`slow relay ${phase} is aborted while score send retains original deadline`, async () => {
    const deadline = Date.now() + 5000;
    let aborted = false;
    let lastplay: string | undefined;
    const deps: AndroidWidgetPushDeps = {
      fetchImpl: (async (_url, opts) => {
        const wait = () => new Promise<never>((_resolve, reject) => {
          opts!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
        });
        if (phase === "headers") return await wait();
        return { ok: true, json: wait } as unknown as Response;
      }) as typeof fetch,
      fansOfTeamsImpl: async () => ({ ids: ["fan"], ok: true }),
      sendFcmImpl: async (_ids, payload, pref, platform, opts) => {
        assert.equal(aborted, true);
        assert.equal(opts?.deadlineAtMs, deadline);
        assert.ok(deadline - Date.now() > 2000);
        assert.equal(pref, "game_start");
        assert.equal(platform, "android");
        assert.equal(payload.data?.w_as, "1");
        assert.equal(payload.data?.w_hs, "0");
        lastplay = payload.data?.w_lastplay;
        return { tokens: 1, sent: 1, failed: 0, cleaned: 0, skipped: 0, ok: true };
      },
    };
    // Keep event loop alive: AbortSignal.timeout uses an unref'ed timer.
    const keepAlive = setInterval(() => {}, 100);
    try {
      const result = await pushAndroidWidgetLiveUpdates([game], "https://test.invalid", { deadlineAtMs: deadline }, deps);
      assert.equal(result.sent, 1);
      assert.equal(lastplay, "");
    } finally { clearInterval(keepAlive); }
  });
}
