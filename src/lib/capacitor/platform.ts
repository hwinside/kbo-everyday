import { Capacitor } from "@capacitor/core";

/** True when running inside the native iOS/Android shell */
export const isNative = Capacitor.isNativePlatform();

// 주입된 네이티브 브릿지(window.Capacitor). 원격 로드(server.url=keubo.fan) 앱은 npm
// @capacitor/core 정적 판정이 'web' false-negative 될 수 있어(PR #484 운영 사고),
// open-external/native-app-review/native-back-button 처럼 window.Capacitor 를 OR 로 본다.
interface InjectedCapacitor {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

/**
 * 동기 native runtime 판정 — npm core 정적 상수 + window.Capacitor 주입 브릿지 OR.
 * 정적 `isNative` 만 보면 원격 로드 설치 앱이 web 으로 오판돼 앱 전용 게이트가 앱을
 * 막는다(삼순 #833 blocker). bridge 접근 throw 는 web 으로 fail-closed.
 */
export function isNativeRuntime(): boolean {
  // 1) npm core (정적 import 된 Capacitor)
  try {
    if (Capacitor.isNativePlatform()) return true;
    const p = Capacitor.getPlatform();
    if (p === "ios" || p === "android") return true;
  } catch {
    /* core 판정 실패 무시 */
  }
  // 2) 주입 브릿지 (원격 로드 dual-instance 우회)
  if (typeof window !== "undefined") {
    try {
      const injected = (window as unknown as { Capacitor?: InjectedCapacitor })
        .Capacitor;
      if (injected?.isNativePlatform?.() === true) return true;
      const ip = injected?.getPlatform?.();
      if (ip === "ios" || ip === "android") return true;
    } catch {
      /* bridge throw → web fail-closed */
    }
  }
  return false;
}

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
 */
export function isIosWeb(): boolean {
  if (isNative) return false; // 네이티브 앱(android/ios) 제외
  if (typeof navigator === "undefined") return false; // SSR 가드
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) return true;
  // iPadOS 13+ Safari는 데스크톱 모드에서 UA가 'Macintosh'로 위장 → 터치포인트로 iPad 판별.
  // (Apple Mac은 터치스크린이 없어 maxTouchPoints=0 → 오탐 없음)
  if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) return true;
  return false;
}
