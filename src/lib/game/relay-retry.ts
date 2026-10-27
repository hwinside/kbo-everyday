/** Exponential client delay is capped; an upstream Retry-After remains a minimum. */
export function relayRetryDelayMs(failures: number, retryAfter?: string | null, now = Date.now()): number {
  const exponential = Math.min(60_000, 5_000 * 2 ** Math.min(Math.max(failures - 1, 0), 4));
  const value = retryAfter?.trim();
  if (!value) return exponential;
  const milliseconds = /^\d+(?:\.\d+)?$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - now;
  return Number.isFinite(milliseconds) ? Math.max(exponential, milliseconds, 0) : exponential;
}
