"use client";

import { registerPlugin } from "@capacitor/core";
import { isNative, isIosNativeRuntime, platform } from "@/lib/capacitor/platform";
import { supabase } from "@/lib/supabase/client";

// 네이티브(iOS/Android) FCM 푸시 토큰 유틸.
// 웹 Web Push는 기존 usePushNotification 경로 유지 — 여기는 native 전용.
// @capacitor-firebase/messaging은 dynamic import로 웹 번들 오염 방지.

// ⚠️ Capacitor plugin proxy를 async 함수에서 직접 반환하면 안 됨 —
// await의 thenable 검사가 proxy의 .then을 네이티브 호출로 변환해
// "FirebaseMessaging.then() is not implemented" 런타임 에러 발생.
// 모듈 namespace(일반 객체)를 반환하고 사용처에서 destructure한다.
function loadMessaging() {
  return import("@capacitor-firebase/messaging");
}

const FOREGROUND_SUPPRESSED_KINDS = new Set([
  "game_live",
  "game_end",
  "game_cancel",
  "la_wake",
  "widget_live", // iOS 홈위젯 무음 갱신(build 17+) — 네이티브 전용, JS 배너 금지
]);

let foregroundListenerAttached = false;
let foregroundBannerTimer: ReturnType<typeof setTimeout> | null = null;

// iOS는 capacitor.config presentationOptions가 포함된 네이티브 빌드(12+)부터 포그라운드에도
// 시스템 배너가 뜬다 — 그 빌드에서 JS 배너까지 겹치면 이중 표시라 리스너를 붙이지 않는다.
// Android는 포그라운드 시스템 표시가 없으므로 항상 JS 배너를 쓴다.
const IOS_NATIVE_FOREGROUND_PRESENTATION_MIN_BUILD = 12;

async function nativePresentsForegroundNotifications(): Promise<boolean> {
  if (platform !== "ios") return false;
  try {
    const { App } = await import("@capacitor/app");
    const info = await App.getInfo();
    return Number(info?.build) >= IOS_NATIVE_FOREGROUND_PRESENTATION_MIN_BUILD;
  } catch {
    // 판별 실패 시 JS 배너 유지 — 이중 표시가 미표시보다 낫다
    return false;
  }
}

function toDataRecord(data: unknown): Record<string, unknown> {
  return data != null && typeof data === "object" ? data as Record<string, unknown> : {};
}

function notificationUrl(data: Record<string, unknown>): string | null {
  const url = typeof data.url === "string" ? data.url : null;
  if (!url) return null;
  if (url.startsWith("/")) return url;
  try {
    const parsed = new URL(url);
    if (parsed.origin === window.location.origin) return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    // ignore invalid URLs
  }
  return null;
}

function showForegroundBanner(title: string, body: string, url: string | null): void {
  if (typeof document === "undefined") return;

  document.getElementById("native-foreground-push-banner")?.remove();
  if (foregroundBannerTimer) clearTimeout(foregroundBannerTimer);

  const banner = document.createElement("button");
  banner.id = "native-foreground-push-banner";
  banner.type = "button";
  banner.setAttribute("aria-label", title);
  banner.style.cssText = [
    "position:fixed",
    "left:12px",
    "right:12px",
    "top:calc(env(safe-area-inset-top, 0px) + 12px)",
    "z-index:2147483647",
    "display:block",
    "border:1px solid rgba(255,255,255,0.14)",
    "border-radius:14px",
    "background:rgba(24,24,27,0.96)",
    "box-shadow:0 12px 36px rgba(0,0,0,0.34)",
    "color:#fff",
    "text-align:left",
    "padding:12px 14px",
    "font:inherit",
    "backdrop-filter:blur(14px)",
    "-webkit-backdrop-filter:blur(14px)",
  ].join(";");

  const titleEl = document.createElement("div");
  titleEl.textContent = title;
  titleEl.style.cssText = "font-size:14px;font-weight:800;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  banner.appendChild(titleEl);

  if (body) {
    const bodyEl = document.createElement("div");
    bodyEl.textContent = body;
    bodyEl.style.cssText = "margin-top:3px;font-size:12px;font-weight:500;line-height:1.35;color:rgba(255,255,255,0.74);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;";
    banner.appendChild(bodyEl);
  }

  banner.onclick = () => {
    banner.remove();
    if (foregroundBannerTimer) clearTimeout(foregroundBannerTimer);
    if (url) window.location.href = url;
  };

  document.body.appendChild(banner);
  foregroundBannerTimer = setTimeout(() => {
    banner.remove();
    foregroundBannerTimer = null;
  }, 6000);
}

/** 서버에 FCM 토큰 등록 (로그인 필수 — 세션 없으면 조용히 skip) */
export async function registerTokenWithServer(fcmToken: string): Promise<boolean> {
  const { data: { session } } = await supabase.auth.getSession();
  const accessToken = session?.access_token;
  if (!accessToken) return false;

  // 앱 빌드 번호 동봉(실패 시 null) — 서버가 빌드 게이트 필터에 사용(widget_live는 17+만,
  // 삼순 #674 blocker⑤). 원격로드 JS라 구빌드도 다음 앱 실행 시 자연스럽게 재보고된다.
  let appBuild: number | null = null;
  try {
    const { App } = await import("@capacitor/app");
    const info = await App.getInfo();
    const b = Number(info?.build);
    if (Number.isFinite(b) && b > 0) appBuild = Math.trunc(b);
  } catch {
    // 판별 실패 = null(구버전 취급) — 등록 자체는 계속
  }

  const res = await fetch("/api/push/register-device", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ fcmToken, platform, appBuild }),
  });
  return res.ok;
}

/**
 * 푸시 권한 요청 + FCM 토큰 발급 + 서버 등록.
 * 트리거: 최애팀 설정 직후 (스펙 확정). 실패는 전부 silent — 앱 동작 무영향.
 */
export async function requestNativePushPermission(): Promise<boolean> {
  if (!isNative) return false;
  try {
    const { FirebaseMessaging } = await loadMessaging();
    const { receive } = await FirebaseMessaging.requestPermissions();
    if (receive !== "granted") return false;

    const { token } = await FirebaseMessaging.getToken();
    if (!token) return false;

    // 토큰 서버 등록까지 성공해야 true — 등록 실패(토큰 row 0건)인데 UI가 "알림 켜짐"으로
    // 보이는 false-positive 방지 (삼순 #220).
    return await registerTokenWithServer(token);
  } catch {
    return false;
  }
}

/**
 * 현재 푸시 권한이 허용(granted) 상태인지 확인 (팝업 없음).
 * 기존 회원/재설치 유저에게 "알림 꺼짐" 안내를 띄울지 판단하는 데 사용.
 * 네이티브 아님/오류 시 true(안내 숨김) — 거짓 경보 방지.
 */
export async function checkNativePushPermission(): Promise<boolean> {
  if (!isNative) return true;
  try {
    const { FirebaseMessaging } = await loadMessaging();
    const { receive } = await FirebaseMessaging.checkPermissions();
    return receive === "granted";
  } catch {
    return true;
  }
}

/**
 * 앱 부팅 시 토큰 동기화: 권한이 이미 granted인 경우에만
 * (권한 팝업을 띄우지 않음) 최신 토큰을 서버에 재등록.
 */
export async function syncNativePushToken(): Promise<void> {
  if (!isNative) return;
  try {
    const { FirebaseMessaging } = await loadMessaging();
    const { receive } = await FirebaseMessaging.checkPermissions();
    if (receive !== "granted") return;

    const { token } = await FirebaseMessaging.getToken();
    if (token) await registerTokenWithServer(token);
  } catch {
    // silent — 푸시는 부가 기능
  }
}

/** FCM 토큰 갱신(rotate) 시 서버 재등록 리스너 */
export async function listenForTokenRefresh(): Promise<void> {
  if (!isNative) return;
  try {
    const { FirebaseMessaging } = await loadMessaging();
    await FirebaseMessaging.addListener("tokenReceived", ({ token }) => {
      if (token) void registerTokenWithServer(token);
    });
  } catch {
    // silent
  }
}

/** 앱 foreground 상태에서 받은 푸시를 인앱 배너로 표시 */
export async function listenForForegroundNotifications(): Promise<void> {
  if (!isNative || foregroundListenerAttached) return;
  foregroundListenerAttached = true;
  if (await nativePresentsForegroundNotifications()) return;
  try {
    const { FirebaseMessaging } = await loadMessaging();
    await FirebaseMessaging.addListener("notificationReceived", (event) => {
      const notification = event.notification;
      const data = toDataRecord(notification?.data);
      const kind = typeof data.kind === "string" ? data.kind : null;
      if (kind && FOREGROUND_SUPPRESSED_KINDS.has(kind)) return;

      const dataTitle = typeof data.title === "string" ? data.title : "";
      const dataBody = typeof data.body === "string" ? data.body : "";
      const title = notification?.title || dataTitle;
      const body = notification?.body || dataBody;
      if (!title && !body) return;

      showForegroundBanner(title || "크보팬", body || "", notificationUrl(data));
    });
  } catch {
    foregroundListenerAttached = false;
  }
}

/** 알림 탭 → 페이로드 data.url 앱 내 경로로 이동 (딥링크) */
export async function listenForNotificationTap(): Promise<void> {
  if (!isNative) return;
  try {
    const { FirebaseMessaging } = await loadMessaging();
    await FirebaseMessaging.addListener("notificationActionPerformed", (event) => {
      const data = toDataRecord(event.notification?.data);
      // notificationUrl — 상대경로 외에 same-origin 절대 URL도 앱 내 경로로 수용
      const url = notificationUrl(data);
      if (url) window.location.href = url;
    });
  } catch {
    // silent
  }
}

interface PushDeepLinkPlugin {
  consume(): Promise<{ url?: string }>;
}

/**
 * iOS cold-start 푸시 탭 딥링크 회수.
 *
 * 앱이 완전 종료된 상태에서 알림을 탭해 launch되면 웹뷰/브릿지가 아직 없어
 * notificationActionPerformed가 유실될 수 있는 iOS 고질 이슈 보완 —
 * AppDelegate가 launch payload의 url을 UserDefaults에 보관해두면(1.0.14+),
 * 웹 부팅 직후 여기서 1회 회수해 해당 페이지로 이동한다.
 *
 * - 원격 로드(server.url) 앱은 npm core가 'web' 오판할 수 있어 isIosNativeRuntime +
 *   주입 브릿지(window.Capacitor.Plugins) 우선 호출(dual-instance 우회, #484/#833 축).
 * - 구버전 네이티브 빌드(플러그인 없음)에서는 호출 실패 → silent no-op.
 */
export async function consumePendingPushDeepLink(): Promise<void> {
  if (!isIosNativeRuntime()) return;
  try {
    const injected = typeof window !== "undefined"
      ? (window as unknown as { Capacitor?: { Plugins?: { PushDeepLink?: PushDeepLinkPlugin } } })
        .Capacitor?.Plugins?.PushDeepLink
      : undefined;
    const plugin = injected ?? registerPlugin<PushDeepLinkPlugin>("PushDeepLink");
    const { url } = await plugin.consume();
    if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//")) return;
    const current = window.location.pathname + window.location.search;
    if (current !== url) window.location.replace(url);
  } catch {
    // 구빌드(플러그인 미탑재)/브릿지 오류 — 딥링크는 부가 기능, 앱 동작 무영향
  }
}
