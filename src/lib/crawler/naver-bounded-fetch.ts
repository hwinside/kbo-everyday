/** Request-path Naver cache: no Next background revalidation (it drops AbortSignal).
 * Fresh responses only; bounded refreshes use the caller’s absolute deadline, including body reads.
 * This is NOT a cross-instance cache. A failed refresh never extends stale data.
 */
const cache = new Map<string, { body: string; status: number; headers: [string, string][]; expiresAt: number }>();
let pendingBySignal = new WeakMap<AbortSignal, Map<string, Promise<void>>>();
const retryAt = new Map<string, number>();
let cacheGeneration = 0;
const MAX_ENTRIES = 128;
const FAILURE_COOLDOWN_MS = 5000;

function trim<T>(map: Map<string, T>) {
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value!);
}

function withinSignal<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function fetchBoundedNaverResponse(
  url: string, ttlMs: number, signal: AbortSignal,
): Promise<Response> {
  signal.throwIfAborted();
  const fresh = () => {
    const entry = cache.get(url);
    return entry && entry.expiresAt > Date.now() ? entry : undefined;
  };
  if (!fresh()) {
    if ((retryAt.get(url) ?? 0) > Date.now()) throw new Error("naver_upstream_cooldown");
    // Coalesce preview/lineup inside one request without mixing callers’ deadlines.
    let pending = pendingBySignal.get(signal);
    if (!pending) { pending = new Map(); pendingBySignal.set(signal, pending); }
    const requestPending = pending;
    let task = requestPending.get(url);
    if (!task) {
      const generation = cacheGeneration;
      task = Promise.resolve().then(async () => {
        try {
          // Keep the ORIGINAL shared absolute deadline; never start a fresh budget.
          // no-store prevents Next from spawning an unbounded stale-cache refresh.
          const response = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)" },
            cache: "no-store",
            signal,
          });
          if (!response.ok) throw new Error(`Naver HTTP ${response.status}`);
          const body = await response.text();
          signal.throwIfAborted();
          JSON.parse(body); // malformed/truncated payloads must not become fresh cache entries
          if (generation !== cacheGeneration) return;
          cache.set(url, { body, status: response.status, headers: [...response.headers], expiresAt: Date.now() + ttlMs });
          trim(cache);
          retryAt.delete(url);
        } catch (error) {
          if (generation === cacheGeneration) {
            retryAt.set(url, Date.now() + FAILURE_COOLDOWN_MS);
            trim(retryAt);
          }
          throw error;
        } finally {
          requestPending.delete(url);
        }
      });
      requestPending.set(url, task);
    }
    await withinSignal(task, signal);
  }
  signal.throwIfAborted();
  const entry = fresh();
  if (!entry) throw new Error("naver_response_unavailable");
  return new Response(entry.body, { status: entry.status, headers: entry.headers });
}

/** Test isolation between upstream fixtures; never used by request paths. */
export function resetBoundedNaverCacheForTest(): void {
  cacheGeneration++;
  cache.clear(); retryAt.clear(); pendingBySignal = new WeakMap();
}
