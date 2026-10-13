/** Transport-only batching. Eligibility/session dedup remain in view-tracker. */
export const IMPRESSION_BATCH_LIMIT = 20;
export const IMPRESSION_BATCH_DELAY_MS = 150;

export function createImpressionBatch(send: (postIds: number[]) => void) {
  let pending: number[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!pending.length) return;
    const batch = pending;
    // Detach before sending: visibilitychange + pagehide must not send twice.
    pending = [];
    send(batch);
  };
  return {
    flush,
    enqueue(postId: number) {
      pending.push(postId);
      if (pending.length >= IMPRESSION_BATCH_LIMIT) flush();
      else if (timer === undefined) timer = setTimeout(flush, IMPRESSION_BATCH_DELAY_MS);
    },
  };
}

/** Validate the whole batch before any counter write. Never accepts click events. */
export function parseImpressionBatch(body: unknown): number[] | null {
  if (!body || typeof body !== "object") return null;
  const ids = (body as { postIds?: unknown }).postIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > IMPRESSION_BATCH_LIMIT) return null;
  if (!ids.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0)) return null;
  return ids;
}
