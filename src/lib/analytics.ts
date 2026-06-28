/**
 * 이벤트 트래킹 (온보딩 + 홈 + 예측)
 *
 * Phase 1: console.log + localStorage 기록
 * Phase 2: GA4 / Supabase analytics 연동
 */

import { getGuestId } from "@/lib/store/onboarding";
import { getStoredAttributionForEvent, getStoredGclid } from "@/hooks/useAdAttribution";

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
   * true면 trackEvent 내부의 *네이티브* Meta App Event(fire-and-forget) 발화를 스킵.
   * Capacitor(웹 원격 로드)에서 가입 직후 hard navigation이 비동기 브릿지 호출을
   * 끊는 레이스를 피하려면, 호출부가 flushNativeMetaForSignup()을 await 한 뒤 이동한다.
   * (웹 Meta Pixel fbq 발화는 그대로 유지)
   */
  skipNative?: boolean;
  /**
   * Google Ads 향상된 전환(Enhanced Conversions)용 유저 이메일.
   * 제공 시 SHA-256 해싱 후 gtag('set', 'user_data') 호출하여
   * 전환 매칭률 향상. gads: true일 때만 사용됨.
   */
  userEmail?: string;
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

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input.trim().toLowerCase());
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

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

  // ONBOARDING_COMPLETE 이벤트에만 ad attribution 필드 병합 (2026-04-19)
  // OAuth 왕복으로 세션 source/medium이 유실되는 케이스 보완 — event scope custom dimension으로 수집
  // 범위는 가입 확정 이벤트 1개에만 집중 (삼순이 리뷰: 1차 확인축 단순화)
  const eventAttribution =
    event === OnboardingEvents.ONBOARDING_COMPLETE ? getStoredAttributionForEvent() : {};
  const ga4Params = { ...payload.properties, ...eventAttribution };

  // GA4 연동 (gtag 있으면) — options.ga4 명시적 false가 아닌 경우만
  if (options?.ga4 !== false && typeof window !== "undefined" && (window as unknown as GtagWindow).gtag) {
    (window as unknown as GtagWindow).gtag!("event", event, ga4Params);
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
    // async IIFE: user_data 세팅 완료 후 conversion 발화 순서 보장
    // 기존: sha256Hex().then() fire-and-forget → conversion이 user_data 없이 먼저 발화 (race condition)
    void (async () => {
      // 향상된 전환: 유저 이메일이 있으면 SHA-256 해싱 후 user_data 설정
      if (options.userEmail) {
        try {
          const hashed = await sha256Hex(options.userEmail);
          (window as unknown as GtagWindow).gtag!("set", "user_data", {
            sha256_email_address: hashed,
          });
        } catch { /* hash 실패 시 skip — 기본 전환은 계속 진행 */ }
      }
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
            // OAuth 이후 세션에서 자동태깅 gclid가 유실된 케이스를 위한 수동 전달 (2026-04-19)
            // sessionStorage에 랜딩 시점 gclid가 남아있으면 conversion 매칭에 사용
            const storedGclid = getStoredGclid();
            if (storedGclid) {
              conversionParams.gclid = storedGclid;
            }
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
    })();
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

  // 네이티브 Meta App Event (fire-and-forget). skipNative면 호출부가 await로 직접 처리.
  if (options?.meta && !options?.skipNative) {
    const nativeMetaEvent = NATIVE_META_EVENT_MAP[event];
    if (nativeMetaEvent) {
      import("@/lib/native-meta-app-events")
        .then(({ logNativeMetaEvent }) => logNativeMetaEvent(nativeMetaEvent, payload.properties))
        .catch((error) => console.warn("[analytics] Native Meta App Event import failed", error));
    }
  }

  // Phase 2: development logging via GA4 debug mode
}

// 온보딩 이벤트
//
// ⚠️ ONBOARDING_COMPLETE 발화 규칙 (2026-04-18 확정):
// - 단 한 곳에서만 발화: /setup POST 성공 직후 (src/app/setup/page.tsx)
// - = "신규 회원가입 확정" 시점 1회.
// - 다른 경로(welcome 재방문, 플레이어 선택 완료, skip→upgrade 등)에서는
//   별도 이벤트(PROFILE_FAVORITES_SET, ONBOARDING_PLAYER_UPGRADED)를 쓸 것.
// - 배경: GA4/Ads 전환 정의를 DB `profiles` 증가분과 1:1로 일치시켜야
//   Smart Bidding 학습 신호가 오염되지 않음.
export const OnboardingEvents = {
  TEAM_SELECT_VIEW: "team_select_view",
  TEAM_SELECTED: "team_selected",
  PLAYER_SELECTED: "player_selected",
  ONBOARDING_COMPLETE: "onboarding_complete",
  ONBOARDING_SKIPPED: "onboarding_skipped",
  // 회원가입 이후 최애선수 목록이 갱신될 때 (가입 완료와 분리)
  PROFILE_FAVORITES_SET: "profile_favorites_set",
  // 가입 시 skip → 나중에 플레이어 선택으로 업그레이드
  ONBOARDING_PLAYER_UPGRADED: "onboarding_player_upgraded",
} as const;

// 네이티브 Meta App Event 이름 매핑 (가입 전환용).
// Subscribe = 최애팀 선택, fb_mobile_complete_registration = 회원가입 완료.
const NATIVE_META_EVENT_MAP: Record<string, string> = {
  [OnboardingEvents.ONBOARDING_COMPLETE]: "fb_mobile_complete_registration",
  [OnboardingEvents.TEAM_SELECTED]: "Subscribe",
};

/**
 * 가입 전환 네이티브 Meta App Event를 *await 가능하게* 발화한다.
 * Capacitor(웹 원격 로드)에서 가입 직후 `window.location.href` hard navigation이
 * 비동기 브릿지 호출을 끊어 Subscribe/CompleteRegistration이 유실되던 문제를 막기 위해,
 * 호출부는 이 함수를 await 한 뒤 화면을 이동시킨다. 웹에서는 no-op(논네이티브 early-return).
 */
export async function flushNativeMetaForSignup(
  event: string,
  properties?: Record<string, unknown>,
): Promise<void> {
  const name = NATIVE_META_EVENT_MAP[event];
  if (!name) return;
  try {
    const { logNativeMetaEvent } = await import("@/lib/native-meta-app-events");
    await logNativeMetaEvent(name, properties);
  } catch (error) {
    console.warn("[analytics] flushNativeMetaForSignup failed", error);
  }
}

// 홈/예측 이벤트 (Day 2)
export const HomeEvents = {
  HOME_CTA_SHOWN: "home_cta_shown",
  HOME_CTA_CLICKED: "home_cta_clicked",
  PREDICTION_CREATED: "prediction_created",
} as const;
