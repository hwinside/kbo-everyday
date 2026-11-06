import test from 'node:test';
import assert from 'node:assert/strict';
import { mapQueryChunks } from '../src/lib/notifications/query-chunks';

test('2307 targets remain ordered and complete with at most three active reads', async () => {
  const input = Array.from({length: 2307}, (_, i) => i);
  let active = 0, peak = 0;
  const result = await mapQueryChunks(input, 200, 3, async chunk => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, chunk[0] % 3));
    active--;
    return chunk;
  });
  assert.equal(peak, 3);
  assert.deepEqual(result.flat(), input);
});

test('failed wave drains, starts no later wave, and returns no partial targets', async () => {
  const started: number[] = [], completed: number[] = [];
  await assert.rejects(mapQueryChunks([0,1,2,3,4,5], 1, 3, async ([id]) => {
    started.push(id);
    if (id === 1) throw new Error('database failure');
    await new Promise(resolve => setTimeout(resolve, 5));
    completed.push(id);
    return id;
  }), /database failure/);
  assert.deepEqual(started, [0,1,2]);
  assert.deepEqual(completed, [0,2]);
});

test('expired deadline rejects next wave without starting its DB requests', async () => {
  let now = 0;
  const queries: number[] = [];
  await assert.rejects(mapQueryChunks([0,1,2,3,4,5], 1, 3, async ([id]) => {
    if (now >= 13) throw new Error('deadline_exceeded');
    queries.push(id);
    await Promise.resolve();
    now = 13;
    return id;
  }), /deadline_exceeded/);
  assert.deepEqual(queries, [0,1,2]);
});

test('default caller concurrency of one stays sequential, including synchronous throws', async () => {
  const seen: number[] = [];
  await assert.rejects(mapQueryChunks([0,1,2], 1, 1, ([id]) => {
    seen.push(id);
    if (id === 1) throw new Error('sync failure');
    return Promise.resolve(id);
  }), /sync failure/);
  assert.deepEqual(seen, [0,1]);
  assert.deepEqual(await mapQueryChunks([], 200, 3, async x => x), []);
});
