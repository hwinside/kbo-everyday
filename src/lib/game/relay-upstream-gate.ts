/** A failed relay stays non-2xx; never replace the client's last good plays. */
export class RelayUpstreamError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: Record<string, unknown>,
  ) {
    super(String(body.error ?? "relay_upstream_error"));
    this.name = "RelayUpstreamError";
  }
}

const FAILURE_COOLDOWN_MS = 5_000;
const MAX_FAILURE_KEYS = 256;

/** Warm-instance only: share in-flight work and briefly suppress failed retries.
 * Not a global circuit breaker, CDN cache, or a fix for upstream connectivity.
 */
export class RelayUpstreamGate<T> {
  private readonly inflight = new Map<string, Promise<T>>();
  private readonly failures = new Map<string, { error: RelayUpstreamError; until: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  retryAfterSeconds(key: string): number {
    const failure = this.failures.get(key);
    return failure ? Math.max(0, Math.ceil((failure.until - this.now()) / 1000)) : 0;
  }

  run(key: string, build: () => Promise<T>): Promise<T> {
    const failure = this.failures.get(key);
    if (failure && failure.until > this.now()) return Promise.reject(failure.error);
    this.failures.delete(key);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const pending = Promise.resolve().then(build).catch((error: unknown) => {
      // Internal/programming errors must not become sticky upstream failures.
      if (error instanceof RelayUpstreamError && error.status === 503) {
        if (this.failures.size >= MAX_FAILURE_KEYS) {
          this.failures.delete(this.failures.keys().next().value!);
        }
        this.failures.set(key, { error, until: this.now() + FAILURE_COOLDOWN_MS });
      }
      throw error;
    }).finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, pending);
    return pending;
  }
}
