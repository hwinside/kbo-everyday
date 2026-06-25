import { Capacitor } from "@capacitor/core";

/** True when running inside the native iOS/Android shell */
export const isNative = Capacitor.isNativePlatform();

/** 'ios' | 'android' | 'web' */
export const platform = Capacitor.getPlatform() as "ios" | "android" | "web";

export const isIOS = platform === "ios";
export const isAndroid = platform === "android";
export const isWeb = platform === "web";

/**
 * Guard: only run the callback inside a native app.
 * Avoids importing native-only plugins on web.
 */
export function runNativeOnly<T>(fn: () => T): T | undefined {
  if (isNative) return fn();
  return undefined;
}

/**
 * True only for an Android *mobile-web* visitor (Android 브라우저/PWA).
 * 설치된 네이티브 앱(android/ios)과 iOS/데스크톱은 모두 false.
 * 비공개 테스트 신규 모집 타깃팅용 — 설치 앱 유저는 이미 테스터, iOS는 안드 테스트 불가.
 * 클라이언트에서만 호출(navigator 의존).
 */
export function isAndroidWeb(): boolean {
  if (isNative) return false; // 네이티브 앱(android/ios) 제외
  if (typeof navigator === "undefined") return false; // SSR 가드
  return /android/i.test(navigator.userAgent);
}

/**
 * True only for an iOS *mobile-web* visitor (iOS Safari/PWA).
 * 설치된 네이티브 앱(android/ios)과 안드/데스크톱은 모두 false.
 * iOS 정식 출시 공지 타깃팅용 — 이미 앱으로 접속한 유저는 받을 필요 없고,
 * 안드/데스크톱은 앱스토어 대상이 아니므로 제외.
 * 클라이언트에서만 호출(navigator 의존).
 * ⚠️ iPadOS 13+ Safari는 데스크톱 모드에서 UA가 'Macintosh'로 위장 → 그 경우 미노출(V1 한계).
 */
export function isIosWeb(): boolean {
  if (isNative) return false; // 네이티브 앱(android/ios) 제외
  if (typeof navigator === "undefined") return false; // SSR 가드
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}
