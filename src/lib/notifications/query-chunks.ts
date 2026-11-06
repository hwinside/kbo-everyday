/** Bounded read-only waves. Preserve input order and drain a failed wave before rejecting. */
export async function mapQueryChunks<T, R>(
  items: readonly T[],
  chunkSize: number,
  concurrency: 1 | 2 | 3,
  query: (chunk: T[]) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error("invalid chunk size");
  if (![1, 2, 3].includes(concurrency)) throw new Error("invalid query concurrency");
  const results: R[] = [];
  for (let offset = 0; offset < items.length; offset += chunkSize * concurrency) {
    const wave: Promise<R>[] = [];
    for (let i = offset; i < Math.min(items.length, offset + chunkSize * concurrency); i += chunkSize) {
      const chunk = items.slice(i, i + chunkSize);
      wave.push(Promise.resolve().then(() => query(chunk)));
    }
    const settled = await Promise.allSettled(wave);
    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
      results.push(result.value);
    }
  }
  return results;
}
