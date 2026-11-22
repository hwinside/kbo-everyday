/** Public source data only. Never cache a user response, partial result or rejected promise. */
export function createVerifiedSourceCache<T>(
  isComplete: (value: T) => boolean,
  ttlMs = 10 * 60_000,
  maxEntries = 256,
) {
  const cache = new Map<string, { value: T; expiresAt: number }>();
  const pending = new Map<string, Promise<T>>();
  let generation = 0;
  const get = async (key: string, fetcher: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const flight = pending.get(key);
    if (flight) return flight;
    const startedGeneration = generation;
    const task = Promise.resolve().then(fetcher).then(value => {
      if (startedGeneration === generation && isComplete(value)) {
        cache.delete(key);
        cache.set(key, { value, expiresAt: Date.now() + ttlMs });
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
      }
      return value;
    }).finally(() => { if (startedGeneration === generation) pending.delete(key); });
    pending.set(key, task);
    return task;
  };
  return Object.assign(get, { clear() { generation++; cache.clear(); pending.clear(); } });
}
