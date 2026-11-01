import { installForegroundTask } from "./foreground-task";

// Never treat arbitrary TypeErrors (programming bugs) as connectivity failures.
export function isNetworkLoadError(message: string): boolean {
  return /^(?:TypeError: )?(?:Load failed|Failed to fetch|NetworkError when attempting to fetch resource\.?|network error)$/i.test(message.trim());
}

/** One delayed reload per five minutes, persisted across navigation. Storage
 * denial disables automatic recovery rather than risking a reload loop.
 * Auth state/cookies are never cleared. Manual error-page actions remain.
 */
export function scheduleNetworkErrorRecovery(message: string): () => void {
  if (typeof window === "undefined" || !isNetworkLoadError(message)) return () => {};
  let attempted = false;
  return installForegroundTask(() => {
    if (attempted) return;
    attempted = true;
    try {
      const key = "kbo_network_reload_at";
      const raw = sessionStorage.getItem(key);
      const last = Number(raw);
      const now = Date.now();
      if (raw !== null && (!Number.isFinite(last) || now - last < 300_000)) return;
      sessionStorage.setItem(key, String(now));
    } catch {
      return;
    }
    window.location.reload();
  });
}
