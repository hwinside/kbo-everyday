import assert from "node:assert/strict";
import test from "node:test";
import { runStartSendChunks } from "../src/lib/notifications/live-activity-channel-policy";

test("cutoff leaves future chunks unclaimed and retryable", async () => {
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

test("concurrent invocations only send rows won by their atomic claim", async () => {
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
