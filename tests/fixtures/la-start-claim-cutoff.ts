import { runStartSendChunks, START_CLAIM_CHUNK_SIZE, START_SEND_CHUNK_SIZE } from "../../src/lib/notifications/live-activity-channel-policy";

// Parent kills this process while the first APNs batch is in flight: no throw/finally.
const claims: number[] = [];
const sends: number[] = [];
const keepAlive = setInterval(() => {}, 1000);
void runStartSendChunks({
  items: Array.from({ length: 501 }, (_, i) => i),
  chunkSize: START_SEND_CHUNK_SIZE,
  claimChunkSize: START_CLAIM_CHUNK_SIZE,
  prepareChunk: async items => { claims.push(...items); return items; },
  sendOne: async id => {
    sends.push(id);
    if (sends.length === START_SEND_CHUNK_SIZE) process.send?.({ claims, sends });
    await new Promise<void>(() => {});
  },
  persistChunk: async () => { throw new Error("must not reach persistence before cutoff"); },
}).finally(() => clearInterval(keepAlive));
