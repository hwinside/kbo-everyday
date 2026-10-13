import { AuthRetryableFetchError } from "@supabase/supabase-js";

type TemporaryStatus = 408 | 429;
type Cooldown = { until: number; status: TemporaryStatus };
const serverCooldowns = new Map<string, Cooldown>();
const MIN_COOLDOWN_MS = 60_000;

/** No token, request body or identity is retained. This is a per-project,
 * per-warm-instance brake, NOT a distributed Supabase rate limiter. */
export function createAuthRefreshGuard(
  supabaseUrl: string,
  fetcher: typeof fetch,
  runtime: "server" | "browser",
) {
  const base = new URL(supabaseUrl);
  const tokenPath = base.pathname.replace(/\/$/, "") + "/auth/v1/token";
  const key = base.origin + tokenPath;
  const cooldowns = runtime === "server" ? serverCooldowns : new Map<string, Cooldown>();
  let preserveCookies = false;

  function delayed(response: Response): Cooldown {
    const now = Date.now();
    const retryAfter = response.headers.get("retry-after");
    const seconds = retryAfter !== null && /^\d+(?:\.\d+)?$/.test(retryAfter.trim())
      ? Number(retryAfter) : NaN;
    const date = retryAfter === null ? NaN : Date.parse(retryAfter);
    const requested = Number.isFinite(seconds) ? seconds * 1000
      : Number.isFinite(date) ? date - now : 0;
    // Never retry earlier than a valid Retry-After, and avoid synchronized
    // client retries. No timers are retained by this guard.
    const jitter = runtime === "browser" ? Math.floor(Math.random() * 5000) : 0;
    return { until: now + Math.max(MIN_COOLDOWN_MS, requested) + jitter, status: response.status as TemporaryStatus };
  }

  function temporaryResponse(cooldown: Cooldown): Response {
    return Response.json({
      // Distinguish a local suppressed retry from a new upstream HTTP failure
      // in the existing allowlisted boot/server diagnostics.
      code: "refresh_backoff",
      message: "Authentication refresh temporarily unavailable",
    }, { status: cooldown.status, headers: {
      "retry-after": String(Math.max(1, Math.ceil((cooldown.until - Date.now()) / 1000))),
      "x-supabase-api-version": "2024-01-01",
    } });
  }

  function temporary(response: Response): Response {
    preserveCookies = true;
    if (runtime === "browser") {
      // auth-js 2.98 treats a JSON 429/408 as terminal and removes the session.
      // Its fetch rejection path produces AuthRetryableFetchError instead.
      // It currently rewraps the status as 0; the inner diagnostics fetch has
      // already observed the REAL HTTP status. Never relabel the HTTP response.
      // The SDK will not consume this failed response after the rejection.
      // Release its stream without reading or retaining the response body.
      void response.body?.cancel().catch(() => {});
      throw new AuthRetryableFetchError("Authentication refresh temporarily unavailable", response.status);
    }
    // SSR must finish promptly, not enter auth-js's ~30s retry loop. Return the
    // real error and veto its destructive cookie batch at the adapter boundary.
    // Request-local SDK state is discarded; this never authenticates the request.
    return response;
  }

  const guardedFetch: typeof fetch = async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, base);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.origin === base.origin && url.pathname === base.pathname.replace(/\/$/, "") + "/auth/v1/logout") {
      // An explicit logout is not a failed refresh. Do not suppress its writes.
      preserveCookies = false;
    }
    const isRefresh = method.toUpperCase() === "POST" && url.origin === base.origin
      && url.pathname === tokenPath && url.searchParams.get("grant_type") === "refresh_token";
    if (!isRefresh) return fetcher(input, init);
    preserveCookies = false;
    const cooldown = cooldowns.get(key);
    if (cooldown && cooldown.until > Date.now()) return temporary(temporaryResponse(cooldown));
    if (cooldown) cooldowns.delete(key);
    const response = await fetcher(input, init);
    if (response.status === 408 || response.status === 429) {
      // The deployment has one project. Bound even unusual multi-project usage.
      if (cooldowns.size >= 16 && !cooldowns.has(key)) cooldowns.delete(cooldowns.keys().next().value!);
      cooldowns.set(key, delayed(response));
      return temporary(response);
    }
    return response;
  };
  return { fetch: guardedFetch, preserveSessionCookies: () => preserveCookies };
}
