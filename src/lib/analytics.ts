/**
 * 이벤트 트래킹 (온보딩 + 홈 + 예측)
 *
 * Phase 1: console.log + localStorage 기록
 * Phase 2: GA4 / Supabase analytics 연동
 */

import { getGuestId } from "@/lib/store/onboarding";

interface GtagWindow extends Window {
  gtag?: (command: string, event: string, params?: Record<string, unknown>) => void;
  fbq?: (command: string, event: string, params?: Record<string, unknown>) => void;
}

interface EventPayload {
  event: string;
  properties?: Record<string, unknown>;
  timestamp?: string;
}

const EVENTS_KEY = "kbo-analytics-events";

export function trackEvent(event: string, properties?: Record<string, unknown>): void {
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
  if (typeof window !== "undefined" && (window as unknown as GtagWindow).gtag) {
    (window as unknown as GtagWindow).gtag!("event", event, payload.properties);
  }

  // Meta Pixel 연동 (fbq 있으면)
  if (typeof window !== "undefined" && (window as unknown as GtagWindow).fbq) {
    // Meta 표준 이벤트 매핑
    const metaEventMap: Record<string, string> = {
      [OnboardingEvents.ONBOARDING_COMPLETE]: "CompleteRegistration",
      [OnboardingEvents.TEAM_SELECTED]: "Subscribe",
    };
    const metaEvent = metaEventMap[event];
    if (metaEvent) {
      (window as unknown as GtagWindow).fbq!("track", metaEvent, payload.properties);
    }
  }

  // Phase 2: development logging via GA4 debug mode
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
