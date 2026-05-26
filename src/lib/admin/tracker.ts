"use client";

import { supabase } from "@/lib/supabase/client";

const VISITOR_KEY = "kbo_visitor_id";

function getVisitorId(): string {
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

export async function trackPageView(userId?: string) {
  if (!userId) return;

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return;

  const visitorId = getVisitorId();
  if (!visitorId) return;

  await supabase.from("admin_page_views").insert({
    visitor_id: visitorId,
    path: window.location.pathname,
    referrer: document.referrer || null,
    user_agent: navigator.userAgent,
    device: getDevice(),
    user_id: userId || null,
  }).then(({ error }) => {
    if (error) console.warn("[tracker] page view insert failed:", error.message);
  });
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
