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

/** Temporary: log celebration triggers for monitoring */
export async function trackCelebration(
  type: string,
  gameId: string,
  teamId: number,
  playerName?: string,
) {
  const visitorId = getVisitorId();
  if (!visitorId) return;

  const path = `/_celeb/${type}/${gameId}`;
  const referrer = [teamId, playerName].filter(Boolean).join("|");

  await supabase.from("admin_page_views").insert({
    visitor_id: visitorId,
    path,
    referrer,
    user_agent: navigator.userAgent,
    device: getDevice(),
    user_id: null,
  }).then(({ error }) => {
    if (error) console.warn("[tracker] celebration log failed:", error.message);
  });
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
