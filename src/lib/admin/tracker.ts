"use client";

import { supabase } from "@/lib/supabase/client";
import { isNative, platform } from "@/lib/capacitor/platform";

const VISITOR_KEY = "kbo_visitor_id";

/** ios_native | android_native | pwa | web — distinguishes the launched app
 * shells from PWA-installed and plain web traffic. PWA is detected via the
 * standalone display-mode (iOS Safari exposes navigator.standalone). */
export function getPlatform(): string {
  if (isNative) {
    if (platform === "ios") return "ios_native";
    if (platform === "android") return "android_native";
    return "native";
  }
  if (typeof window !== "undefined") {
    const standalone =
      window.matchMedia?.("(display-mode: standalone)")?.matches === true ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (standalone) return "pwa";
  }
  return "web";
}

export function getVisitorId(): string {
  if (typeof window === "undefined") return "";
  let id = localStorage.getItem(VISITOR_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(VISITOR_KEY, id);
  }
  return id;
}

function getDevice(): string {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent;
  if (/Mobile|Android|iPhone/.test(ua)) return "mobile";
  if (/Tablet|iPad/.test(ua)) return "tablet";
  return "desktop";
}

// Native app version+build (e.g. "1.0.3 (6)") for the admin version-share card.
// Cached for the session (it never changes); null on web/PWA or if unavailable.
// undefined = not yet resolved.
let cachedAppVersion: string | null | undefined;

export async function getAppVersion(): Promise<string | null> {
  if (cachedAppVersion !== undefined) return cachedAppVersion;
  if (!isNative) {
    cachedAppVersion = null;
    return null;
  }
  try {
    const { App } = await import("@capacitor/app");
    const info = await App.getInfo();
    cachedAppVersion = info?.version
      ? `${info.version}${info.build ? ` (${info.build})` : ""}`
      : null;
  } catch {
    cachedAppVersion = null;
  }
  return cachedAppVersion;
}

export async function trackPageView(userId?: string) {
  if (!userId) return;

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return;

  const visitorId = getVisitorId();
  if (!visitorId) return;

  const appVersion = await getAppVersion();

  await supabase.from("admin_page_views").insert({
    visitor_id: visitorId,
    path: window.location.pathname,
    referrer: document.referrer || null,
    user_agent: navigator.userAgent,
    device: getDevice(),
    platform: getPlatform(),
    app_version: appVersion,
    user_id: userId || null,
  }).then(({ error }) => {
    if (error) console.warn("[tracker] page view insert failed:", error.message);
  });
}

// ---- Accurate per-page active dwell time (platform 체류시간 v2) ----
// We measure foreground active time on each page (paused while the tab is
// hidden) and beacon it on page leave / tab hide / route change. Mobile shells
// don't fire `beforeunload`, so visibilitychange + pagehide drive the flush and
// sendBeacon survives the unload. One page visit may emit several events (one
// per visible interval); they sum back together server-side per session.
//
// Population is pinned to logged-in users (same as page-view tracking): we only
// send when we hold an auth token, and the server derives user_id from the
// verified JWT rather than trusting any client-claimed id.

const MAX_DWELL_MS = 30 * 60 * 1000; // cap a single visible interval (idle guard)
const MIN_DWELL_MS = 1000; // skip sub-second noise

let dwellPath: string | null = null;
let dwellToken: string | null = null;
let dwellActiveMs = 0;
let dwellResumeAt: number | null = null;

/** Supply the current access token (logged in) or null (logged out → no
 * tracking). Set by DwellTracker on auth/route changes. */
export function dwellSetAuth(token: string | null) {
  dwellToken = token;
  // Logged out: drop anything queued — the population is logged-in users only
  // and we no longer hold a token to authenticate the batch.
  if (token == null) {
    dwellQueue = [];
    if (dwellFlushTimer != null) {
      clearTimeout(dwellFlushTimer);
      dwellFlushTimer = null;
    }
  }
}

function settleDwell() {
  if (dwellResumeAt != null) {
    dwellActiveMs += Date.now() - dwellResumeAt;
    dwellResumeAt = null;
  }
}

function emitDwell() {
  settleDwell();
  const ms = Math.min(dwellActiveMs, MAX_DWELL_MS);
  const path = dwellPath;
  dwellActiveMs = 0;
  if (!path || ms < MIN_DWELL_MS) return;
  enqueueDwell(path, ms);
}

/** Finalize the page being left, then begin timing the new one. */
export function dwellStartPage(path: string) {
  emitDwell();
  dwellPath = path;
  dwellActiveMs = 0;
  dwellResumeAt =
    typeof document === "undefined" || document.visibilityState === "visible"
      ? Date.now()
      : null;
}

/** Tab hidden / page hide: settle the current interval and flush the queue
 * immediately — the page may be about to die and sendBeacon survives unload. */
export function dwellPause() {
  emitDwell();
  flushDwellQueue();
}

/** Tab visible again: resume timing the same page. */
export function dwellResume() {
  if (
    dwellPath &&
    dwellResumeAt == null &&
    (typeof document === "undefined" || document.visibilityState === "visible")
  ) {
    dwellResumeAt = Date.now();
  }
}

// ---- Batched dwell delivery ----
// Route changes used to fire one POST each (~180K requests/day at current
// traffic). Finished intervals are now queued and delivered as one batched
// POST every DWELL_FLUSH_INTERVAL_MS, plus an immediate flush on
// pagehide/tab-hide (sendBeacon survives unload) so leaving never loses data.
const DWELL_FLUSH_INTERVAL_MS = 30_000;
const DWELL_QUEUE_MAX = 20; // safety cap; flush early if a burst piles up

let dwellQueue: { path: string; dwellMs: number }[] = [];
let dwellFlushTimer: ReturnType<typeof setTimeout> | null = null;

function enqueueDwell(path: string, dwellMs: number) {
  if (!dwellToken) return; // logged-out / no session → not tracked
  const last = dwellQueue[dwellQueue.length - 1];
  if (last && last.path === path) {
    // Repeated intervals on the same page (visibility toggles): merge instead
    // of growing the queue. Server caps a row at MAX_DWELL_MS either way.
    last.dwellMs = Math.min(last.dwellMs + Math.round(dwellMs), MAX_DWELL_MS);
  } else {
    dwellQueue.push({ path, dwellMs: Math.round(dwellMs) });
  }
  if (dwellQueue.length >= DWELL_QUEUE_MAX) {
    flushDwellQueue();
    return;
  }
  if (dwellFlushTimer == null) {
    dwellFlushTimer = setTimeout(flushDwellQueue, DWELL_FLUSH_INTERVAL_MS);
  }
}

/** Send everything queued in a single POST. Safe to call any time; no-op when
 * the queue is empty. Exposed for DwellTracker's unload path. */
export function flushDwellQueue() {
  if (dwellFlushTimer != null) {
    clearTimeout(dwellFlushTimer);
    dwellFlushTimer = null;
  }
  if (dwellQueue.length === 0) return;
  const token = dwellToken;
  if (!token) {
    dwellQueue = [];
    return;
  }
  const visitorId = getVisitorId();
  if (!visitorId) {
    dwellQueue = [];
    return;
  }
  const events = dwellQueue;
  dwellQueue = [];

  const body = JSON.stringify({
    visitorId,
    platform: getPlatform(),
    accessToken: token,
    events,
  });
  const url = "/api/telemetry/page-dwell";

  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon(url, blob)) return;
    }
    void fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    });
  } catch (error) {
    console.warn("[tracker] dwell send failed:", error);
  }
}

/** Temporary: log celebration triggers for monitoring. inning + eventId are
 * recorded so we can trace mis-attribution (e.g. wrong batter) back to the
 * exact event that triggered the celebration.
 *
 * `source` distinguishes the relay-bridged path from the KBO BoxScore-diff
 * path so the admin panel can graph relay-vs-kbo gap P50/P90. `eventTimeMs`
 * records the GameEvent.timestamp at fire time (so server-side gap math
 * doesn't depend on celebration-trigger ingest latency). */
export async function trackCelebration(
  type: string,
  gameId: string,
  teamId: number,
  playerName?: string,
  eventId?: string,
  inning?: number,
  isTop?: boolean,
  source?: string,
  eventTimeMs?: number,
) {
  const visitorId = getVisitorId();
  if (!visitorId) return;

  const body = JSON.stringify({
    visitorId, type, gameId, teamId, playerName, eventId, inning, isTop,
    source, eventTimeMs, firedAtMs: Date.now(),
  });
  const url = "/api/telemetry/celebration-trigger";

  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon(url, blob)) return;
    }

    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    });
  } catch (error) {
    console.warn("[tracker] celebration log failed:", error);
  }
}

export async function trackPerfMetric(metricName: string, value: number) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return;

  await supabase.from("admin_perf_metrics").insert({
    path: window.location.pathname,
    metric_name: metricName,
    value,
  }).then(({ error }) => {
    if (error) console.warn("[tracker] perf metric insert failed:", error.message);
  });
}

export function initWebVitals() {
  if (typeof window === "undefined") return;

  // Use PerformanceObserver for Core Web Vitals
  try {
    // LCP
    const lcpObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) trackPerfMetric("LCP", last.startTime / 1000);
    });
    lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });

    // FID
    const fidObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const fidEntry = entry as PerformanceEventTiming;
        trackPerfMetric("FID", fidEntry.processingStart - fidEntry.startTime);
      }
    });
    fidObserver.observe({ type: "first-input", buffered: true });

    // CLS
    let clsValue = 0;
    const clsObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const layoutShift = entry as PerformanceEntry & { hadRecentInput: boolean; value: number };
        if (!layoutShift.hadRecentInput) {
          clsValue += layoutShift.value;
        }
      }
    });
    clsObserver.observe({ type: "layout-shift", buffered: true });

    // Report CLS on page hide
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        trackPerfMetric("CLS", clsValue);
      }
    });
  } catch {
    // PerformanceObserver not supported
  }
}
