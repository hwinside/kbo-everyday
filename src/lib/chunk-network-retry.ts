/** Retry a failed Next script before Turbopack permanently rejects its URL promise.
 * Re-running import() after rejection cannot reset that private runtime cache.
 * Scoped to active home imports; no runtime internals or arbitrary URLs are used.
 */
let users = 0;
const attempted = new Set<string>();
const forwarded = new WeakSet<Event>();

function onScriptError(event: Event) {
  if (forwarded.has(event)) return;
  const script = event.target;
  if (!(script instanceof HTMLScriptElement) || !script.isConnected) return;
  const url = new URL(script.src, window.location.href);
  if (url.origin !== window.location.origin ||
      !/^\/_next\/static\/chunks\/[a-zA-Z0-9_.-]+\.js$/.test(url.pathname) ||
      attempted.has(url.href)) return;

  attempted.add(url.href);
  // Capture runs before the loader's target error listener. Keep its original
  // promise pending until the retry registers the chunk or fails definitively.
  event.stopImmediatePropagation();
  event.preventDefault();
  const retry = script.cloneNode(false) as HTMLScriptElement;
  // A clone must not inherit unrelated inline handlers.
  retry.removeAttribute("onerror");
  retry.removeAttribute("onload");
  url.searchParams.set("__kbo_chunk_retry", "1");
  attempted.add(url.href);
  retry.src = url.href;
  let settled = false;
  let timeout: ReturnType<typeof setTimeout>;
  const finish = (ok: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    retry.onload = null;
    retry.onerror = null;
    if (!ok) {
      retry.remove();
      const failure = new Event("error");
      forwarded.add(failure);
      // Notify the ORIGINAL element: its listeners belong to the pending
      // Turbopack promise. This reaches the existing boundary/reload fallback.
      script.dispatchEvent(failure);
    }
  };
  retry.onload = () => finish(true);
  retry.onerror = () => finish(false);
  setTimeout(() => {
    if (!script.isConnected) { finish(false); return; }
    timeout = setTimeout(() => finish(false), 10_000);
    document.head.appendChild(retry);
  }, 1_000);
}

export function acquireChunkNetworkRetry(): () => void {
  if (typeof window === "undefined") return () => {};
  if (users++ === 0) window.addEventListener("error", onScriptError, true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--users === 0) window.removeEventListener("error", onScriptError, true);
  };
}
