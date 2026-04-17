/**
 * 이벤트 트래킹 (온보딩 + 홈 + 예측)
 *
 * Phase 1: console.log + localStorage 기록
 * Phase 2: GA4 / Supabase analytics 연동
 */

import { getGuestId } from "@/lib/store/onboarding";

interface GtagWindow extends Window {
  gtag?: (command: string, event: string, params?: Record<string, unknown> | (() => void)) => void;
  fbq?: (command: string, event: string, params?: Record<string, unknown>) => void;
}

interface EventPayload {
  event: string;
  properties?: Record<string, unknown>;
  timestamp?: string;
}

const EVENTS_KEY = "kbo-analytics-events";

interface TrackOptions {
  /** true면 Meta Pixel 표준 이벤트로도 발화 (기본 false) */
  meta?: boolean;
  /** true면 Google Ads 전환 이벤트도 발화 (기본 false) */
  gads?: boolean;
  /** false면 GA4 기본 발화 스킵 (Ads-only / Meta-only 분리용, 기본 true) */
  ga4?: boolean;
  /**
   * Google Ads 전환 발화 후 호출되는 콜백. gtag `event_callback` 경로로 연결되어
   * beacon 전송 완료/타임아웃 후 실행됨. redirect 직전 호출에 사용 (navigation race 방지).
   * gads가 true가 아니거나 gtag가 없으면 즉시 동기 호출됨.
   */
  onGadsComplete?: () => void;
  /** onGadsComplete 호출 전까지 기다릴 최대 시간(ms). 기본 2000. */
  gadsCallbackTimeout?: number;
}

// Google Ads 전환 라벨 매핑 (AW-18082281693)
const GADS_CONVERSION_MAP: Record<string, string> = {
  // 회원가입 완료 (닉네임+팀 설정까지)
  ["onboarding_complete"]: "AW-18082281693/-AI9CJa8l5ocEN3xpq5D",
};

export function trackEvent(event: string, properties?: Record<string, unknown>, options?: TrackOptions): void {
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

  // GA4 연동 (gtag 있으면) — options.ga4 명시적 false가 아닌 경우만
  if (options?.ga4 !== false && typeof window !== "undefined" && (window as unknown as GtagWindow).gtag) {
    (window as unknown as GtagWindow).gtag!("event", event, payload.properties);
  }

  // Google Ads 전환 연동 — gads: true 인 경우만 발화 (세션당 1회 제한)
  // onGadsComplete가 있으면 gtag event_callback으로 연결 (redirect 직전 beacon flush)
  let gadsCallbackFired = false;
  const fireCallbackOnce = () => {
    if (gadsCallbackFired) return;
    gadsCallbackFired = true;
    if (options?.onGadsComplete) {
      try { options.onGadsComplete(); } catch { /* ignore */ }
    }
  };

  if (options?.gads && typeof window !== "undefined" && (window as unknown as GtagWindow).gtag) {
    const sendTo = GADS_CONVERSION_MAP[event];
    if (sendTo) {
      const convKey = `gads_sent_${event}`;
      try {
        if (!sessionStorage.getItem(convKey)) {
          sessionStorage.setItem(convKey, "1");
          const conversionParams: Record<string, unknown> = {
            send_to: sendTo,
            value: 1.0,
            currency: "KRW",
          };
          if (options?.onGadsComplete) {
            conversionParams.event_callback = fireCallbackOnce;
            // 안전장치: beacon이 지연되거나 차단되어도 지정 시간 후 강제 진행
            const timeoutMs = options.gadsCallbackTimeout ?? 2000;
            window.setTimeout(fireCallbackOnce, timeoutMs);
          }
          (window as unknown as GtagWindow).gtag!("event", "conversion", conversionParams);
        } else if (options?.onGadsComplete) {
          // 이미 세션 내 발화됨 — 콜백만 즉시 실행
          fireCallbackOnce();
        }
      } catch {
        // sessionStorage 접근 실패 — 정책상 skip + 콜백만 실행
        if (options?.onGadsComplete) fireCallbackOnce();
      }
    } else if (options?.onGadsComplete) {
      // 매핑 없는 이벤트 — 콜백만 실행
      fireCallbackOnce();
    }
  } else if (options?.onGadsComplete) {
    // gads 옵션 없거나 gtag 미로드 — 콜백만 즉시 실행
    fireCallbackOnce();
  }

  // Meta Pixel 연동 — 명시적으로 meta: true 인 경우만 발화 (중복 방지)
  if (options?.meta && typeof window !== "undefined" && (window as unknown as GtagWindow).fbq) {
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
