/**
 * 이벤트 트래킹 (온보딩 + 홈 + 예측)
 *
 * Phase 1: console.log + localStorage 기록
 * Phase 2: GA4 / Supabase analytics 연동
 */

import { getGuestId } from "@/lib/store/onboarding";

interface EventPayload {
  event: string;
  properties?: Record<string, any>;
  timestamp?: string;
}

const EVENTS_KEY = "kbo-analytics-events";

export function trackEvent(event: string, properties?: Record<string, any>): void {
  if (typeof window === "undefined") return;

  const payload: EventPayload = {
    event,
    properties: {
      ...properties,
      guest_id: getGuestId(),
      url: window.location.pathname,
    },
    timestamp: new Date().toISOString(),
  };

  // Phase 1: localStorage에 축적 (디버깅/분석용)
  try {
    const stored = JSON.parse(localStorage.getItem(EVENTS_KEY) || "[]");
    stored.push(payload);
    // 최근 200개만 유지
    if (stored.length > 200) stored.splice(0, stored.length - 200);
    localStorage.setItem(EVENTS_KEY, JSON.stringify(stored));
  } catch {
    // storage full — skip
  }

  // GA4 연동 (gtag 있으면)
  if (typeof window !== "undefined" && (window as any).gtag) {
    (window as any).gtag("event", event, payload.properties);
  }

  if (process.env.NODE_ENV === "development") {
    console.log(`[analytics] ${event}`, payload.properties);
  }
}

// 온보딩 이벤트
export const OnboardingEvents = {
  TEAM_SELECT_VIEW: "team_select_view",
  TEAM_SELECTED: "team_selected",
  PLAYER_SELECTED: "player_selected",
  ONBOARDING_COMPLETE: "onboarding_complete",
  ONBOARDING_SKIPPED: "onboarding_skipped",
} as const;

// 홈/예측 이벤트 (Day 2)
export const HomeEvents = {
  HOME_CTA_SHOWN: "home_cta_shown",
  HOME_CTA_CLICKED: "home_cta_clicked",
  PREDICTION_CREATED: "prediction_created",
} as const;
