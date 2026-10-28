import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { runStartSendChunks, decideStartReissue, START_CLAIM_CHUNK_SIZE, START_SEND_CHUNK_SIZE } from "../src/lib/notifications/live-activity-channel-policy";

test("persist exception leaves future chunks unclaimed and retryable", async () => {
  const claims = new Set<number>();
  const sent: number[] = [];
  const prepareChunk = async (items: readonly number[]) => items.filter(id => {
    if (claims.has(id)) return false;
    claims.add(id);
    return true;
  });
  await assert.rejects(runStartSendChunks({
    items: [1, 2, 3, 4], chunkSize: 2, prepareChunk,
    sendOne: async id => { sent.push(id); },
    persistChunk: async () => { throw new Error("cutoff"); },
  }), /cutoff/);
  assert.deepEqual([...claims], [1, 2]);
  await runStartSendChunks({
    items: [1, 2, 3, 4], chunkSize: 2, prepareChunk,
    sendOne: async id => { sent.push(id); }, persistChunk: async () => {},
  });
  assert.deepEqual(sent, [1, 2, 3, 4]);
});

test("runner sends only winners returned by an in-memory atomic-claim stub (not DB concurrency)", async () => {
  const claims = new Set<number>();
  const sent: number[] = [];
  const run = () => runStartSendChunks({
    items: [1, 2, 3, 4], chunkSize: 2,
    prepareChunk: async items => items.filter(id => {
      if (claims.has(id)) return false;
      claims.add(id);
      return true;
    }),
    sendOne: async id => { sent.push(id); }, persistChunk: async () => {},
  });
  await Promise.all([run(), run()]);
  assert.deepEqual(sent.sort(), [1, 2, 3, 4]);
});

test("claim failure stops without sending or claiming later chunks", async () => {
  let calls = 0;
  let sent = 0;
  await runStartSendChunks({
    items: [1, 2, 3], chunkSize: 1,
    prepareChunk: async () => { calls++; return null; },
    sendOne: async () => { sent++; }, persistChunk: async () => {},
  });
  assert.equal(calls, 1);
  assert.equal(sent, 0);
});


test("200-row claims preserve 100-row send/persist boundaries and original round-trip count", async () => {
  const events: string[] = [];
  let claims = 0;
  await runStartSendChunks({
    items: Array.from({ length: 501 }, (_, i) => i),
    chunkSize: START_SEND_CHUNK_SIZE, claimChunkSize: START_CLAIM_CHUNK_SIZE,
    prepareChunk: async items => { claims++; events.push(`claim:${items.length}`); return items; },
    sendOne: async id => { events.push(`send:${id}`); },
    persistChunk: async () => { events.push("persist"); },
  });
  assert.equal(claims, Math.ceil(501 / 200));
  assert.equal(events.filter(e => e === "persist").length, 6);
  assert.equal(events[events.indexOf("send:100") - 1], "persist");
  assert.equal(events[events.indexOf("claim:200", 1) - 1], "persist");
});

test("existing current-generation claims exit eligibility with zero upserts", async () => {
  const eligible = Array.from({ length: 501 }, (_, i) => i).filter(() => decideStartReissue({
    tokenGenerationMs: 1000, claimCreatedAtMs: 2000,
    hasCurrentTokenSubscription: false, gameStartMs: 3000, nowMs: 4000, startWindowMs: 90000,
  }).eligible);
  let upserts = 0;
  await runStartSendChunks({
    items: eligible, chunkSize: START_SEND_CHUNK_SIZE, claimChunkSize: START_CLAIM_CHUNK_SIZE,
    prepareChunk: async items => { upserts++; return items; },
    sendOne: async () => { assert.fail("already claimed"); }, persistChunk: async () => {},
  });
  assert.equal(upserts, 0);
});

test("empty conflict batches do not starve a later unclaimed user", async () => {
  const sent: number[] = [];
  await runStartSendChunks({
    items: [1, 2, 3, 4, 5], chunkSize: 1, claimChunkSize: 2,
    prepareChunk: async items => items.filter(id => id === 5),
    sendOne: async id => { sent.push(id); }, persistChunk: async () => {},
  });
  assert.deepEqual(sent, [5]);
});

test("hard process cutoff leaves at most 200 claimed rows and future batches retryable", { timeout: 10000 }, async () => {
  const child = fork("tests/fixtures/la-start-claim-cutoff.ts", [], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  try {
    const [snapshot] = await once(child, "message", { signal: AbortSignal.timeout(5000) }) as [{ claims: number[]; sends: number[] }];
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    const [, signal] = await exited;
    assert.equal(signal, "SIGKILL");
    assert.equal(snapshot.claims.length, START_CLAIM_CHUNK_SIZE);
    assert.equal(snapshot.sends.length, START_SEND_CHUNK_SIZE);
    const claims = new Set(snapshot.claims);
    const retried: number[] = [];
    await runStartSendChunks({
      items: Array.from({ length: 501 }, (_, i) => i),
      chunkSize: START_SEND_CHUNK_SIZE, claimChunkSize: START_CLAIM_CHUNK_SIZE,
      prepareChunk: async items => items.filter(id => !claims.has(id)),
      sendOne: async id => { retried.push(id); }, persistChunk: async () => {},
    });
    assert.deepEqual(retried, Array.from({ length: 301 }, (_, i) => i + 200));
  } finally {
    child.kill("SIGKILL");
  }
});
