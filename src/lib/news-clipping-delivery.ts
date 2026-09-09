/** The RPC is atomic; timeout/unknown response must never fall back to an
 * unclaimed DM insert. Retrying the same delivery day is idempotent. */
export const CLIPPING_BATCH_SIZE = 200;
export const CLIPPING_RPC_TIMEOUT_MS = 20_000;

export interface ClippingBatch {
  sent: number;
  firstIntro: number;
  targets: number;
  skippedPref: number;
  alreadySent: number;
  remaining: number;
}
export interface ClippingProgress extends Omit<ClippingBatch, "remaining"> {
  remaining: number | null;
  timedOut: boolean;
  batches: number;
}

export async function runClippingDelivery(
  callBatch: () => Promise<unknown>, deadline: number, now: () => number = Date.now,
): Promise<ClippingProgress> {
  const result: ClippingProgress = { sent: 0, firstIntro: 0, targets: 0,
    skippedPref: 0, alreadySent: 0, remaining: null, timedOut: false, batches: 0 };
  while (result.remaining === null || result.remaining > 0) {
    if (now() + CLIPPING_RPC_TIMEOUT_MS + 5_000 >= deadline) {
      result.timedOut = true;
      break;
    }
    const batch = await callBatch() as ClippingBatch | null;
    const keys = ["sent", "targets", "skippedPref", "alreadySent", "firstIntro", "remaining"] as const;
    if (!batch || keys.some((key) => !Number.isInteger(batch[key]) || batch[key] < 0)
      || batch.sent > CLIPPING_BATCH_SIZE || batch.firstIntro > batch.sent) {
      throw new Error("invalid atomic delivery result");
    }
    const previouslySentHere = result.sent;
    result.sent += batch.sent;
    result.firstIntro += batch.firstIntro;
    result.targets = batch.targets;
    result.skippedPref = batch.skippedPref;
    result.alreadySent = Math.max(0, batch.alreadySent - previouslySentHere);
    result.remaining = batch.remaining;
    result.batches++;
    if (batch.sent === 0 && batch.remaining > 0) break;
  }
  return result;
}
