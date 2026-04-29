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
