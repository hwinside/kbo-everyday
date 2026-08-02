"use client";

// ── 알림 탭 딥링크: 앱이 *활성화된 뒤에* 이동 ──────────────────────────────
// iOS 와 Android 는 알림 탭 이벤트가 뜨는 시점이 구조적으로 다르다.
//  - Android: FirebaseMessagingPlugin.handleOnNewIntent(Intent) = 액티비티 라이프사이클 훅.
//    앱이 이미 포그라운드로 올라온 뒤에 JS 로 전달돼 즉시 이동이 그대로 먹는다.
//  - iOS: UNUserNotificationCenter didReceive(response:) = 알림 델리게이트 콜백.
//    앱이 아직 백그라운드→활성 전환 *중*일 때 먼저 불린다. 이 시점 WKWebView 는
//    JS 네비게이션이 억제돼 location.href 대입이 유실되고, 활성화 후 웹뷰는 원래 있던
//    화면(대개 홈)에 그대로 남는다 → 하린아빠 실기기 제보(2026-08-02, iOS 백그라운드에서
//    라인업 알림 탭 시 홈으로 감. 같은 시각 A17 안드는 라인업으로 정상 진입).
//
// 그래서 탭 URL 을 즉시 이동시키지 않고 *보관*했다가 앱이 실제로 활성화된 시점에 적용한다.
// 이미 활성(visible)이면 그 자리에서 바로 이동하므로 Android 동작은 종전과 동일하다.
// 보관분은 1회만 소비하고, 활성화 전에 새 탭이 오면 최신 URL 로 덮는다(마지막 탭 우선).
//
// supabase 등 무거운 의존을 두지 않는다 — 이 계약만 독립 회귀로 검증하기 위함.

let pendingTapUrl: string | null = null;
let activationListenerAttached = false;

function consumePendingTapUrl(): void {
  const url = pendingTapUrl;
  if (!url) return;
  pendingTapUrl = null; // 재진입 방지 — 이동 전에 먼저 비운다
  window.location.href = url;
}

/**
 * 알림 탭 딥링크 이동.
 * 문서가 이미 보이는 상태면 즉시, 아니면 활성화될 때까지 보관 후 적용한다.
 * window/document 부재(SSR)에서는 아무것도 하지 않는다.
 */
export function navigateOnAppActive(url: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  pendingTapUrl = url;

  if (document.visibilityState === "visible") {
    consumePendingTapUrl();
    return;
  }

  // 아직 백그라운드/전환 중 — 활성화 신호를 기다린다. 리스너는 1회만 부착하고 계속 유지한다
  // (매 탭마다 붙였다 떼면 전환 타이밍에 따라 신호를 놓칠 수 있다).
  if (activationListenerAttached) return;
  activationListenerAttached = true;
  const onActive = () => {
    if (document.visibilityState === "visible") consumePendingTapUrl();
  };
  document.addEventListener("visibilitychange", onActive);
  // visibilitychange 가 안 오는 기기/전환 경로 대비 — focus/pageshow 도 같은 게이트로 받는다.
  window.addEventListener("focus", onActive);
  window.addEventListener("pageshow", onActive);
}

/**
 * 알림 탭 이벤트 처리 — `notificationActionPerformed` 핸들러 본문.
 * 플러그인 리스너에서 분리해 둔 이유는, 이 판정(내부경로만 허용 + 활성화 후 이동)을
 * 네이티브 플러그인 없이 실행 경로 그대로 회귀 검증하기 위함이다.
 */
export function handleNotificationTapEvent(event: unknown): void {
  const notification = (event as { notification?: { data?: unknown } } | null)?.notification;
  const data = (notification?.data ?? {}) as Record<string, unknown>;
  const url = typeof data.url === "string" ? data.url : null;
  // 내부 경로(`/`)만 허용. `//host`와 `/\\host`도 URL parser에서 외부 origin이 되므로
  // startsWith만 믿지 않고 실제 해석된 origin까지 대조한다.
  if (!url || !url.startsWith("/")) return;
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin !== window.location.origin) return;
    navigateOnAppActive(parsed.pathname + parsed.search + parsed.hash);
  } catch {
    // malformed path — 이동하지 않는다
  }
}

type MessagingListenerSource = {
  addListener: (
    event: "notificationActionPerformed",
    listener: (event: unknown) => void,
  ) => Promise<unknown>;
};

/** Firebase Messaging 플러그인에 탭 리스너를 실제로 등록한다. */
export async function registerNotificationTapListener(
  messaging: MessagingListenerSource,
): Promise<void> {
  await messaging.addListener("notificationActionPerformed", handleNotificationTapEvent);
}

/** 테스트 전용 — 모듈 보관 상태 초기화. */
export function __resetPendingTapForTest(): void {
  pendingTapUrl = null;
  activationListenerAttached = false;
}
