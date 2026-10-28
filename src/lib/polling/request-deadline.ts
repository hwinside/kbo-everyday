/** Bound headers AND body/stream consumption, even if fetch ignores abort. */
export function withRequestDeadline<T>(
  controller: AbortController,
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Request cancelled", "AbortError"));
    };
    if (controller.signal.aborted) {
      reject(new DOMException("Request cancelled", "AbortError"));
      return;
    }
    const timer = setTimeout(() => controller.abort(new DOMException("Request deadline exceeded", "TimeoutError")), timeoutMs);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    // Attach both handlers so an abort-ignoring operation cannot leak a late rejection.
    Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new DOMException("Request cancelled", "AbortError");
      return operation();
    }).then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

// Server requests are bounded separately; transport/body stalls still need a client fence.
export const LIVE_REQUEST_TIMEOUT_MS = 8_000;
export const RELAY_REQUEST_TIMEOUT_MS = 8_000;
