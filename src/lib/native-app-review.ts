import { registerPlugin } from "@capacitor/core";

interface AppReviewPlugin {
  requestReview(): Promise<void>;
}

const AppReview = registerPlugin<AppReviewPlugin>("AppReview");

// 주입된 네이티브 브릿지(window.Capacitor) — 원격 로드(server.url) 시 npm @capacitor/core가
// 'web'으로 오판하는 케이스를 우회하기 위해 직접 접근한다(native-meta-app-events.ts와 동일 패턴).
interface InjectedCapacitor {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: {
    AppReview?: { requestReview?: () => Promise<void> };
  };
}

function getInjectedCapacitor(): InjectedCapacitor | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { Capacitor?: InjectedCapacitor }).Capacitor;
}

/** npm core 또는 주입 브릿지 어느 쪽이든 native(ios/android)면 true. 웹에선 false. */
export async function detectNativeRuntime(): Promise<boolean> {
  let coreNative: boolean | undefined;
  let platform: string | undefined;
  try {
    const { Capacitor } = await import("@capacitor/core");
    coreNative = Capacitor.isNativePlatform();
    platform = Capacitor.getPlatform?.();
  } catch {
    /* core 로드 실패 무시 */
  }

  const injected = getInjectedCapacitor();
  let bridgeNative: boolean | undefined;
  let injectedPlatform: string | undefined;
  try {
    bridgeNative = injected?.isNativePlatform?.();
  } catch {
    /* 무시 */
  }
  try {
    injectedPlatform = injected?.getPlatform?.();
  } catch {
    /* 무시 */
  }

  return (
    coreNative === true ||
    bridgeNative === true ||
    platform === "ios" ||
    platform === "android" ||
    injectedPlatform === "ios" ||
    injectedPlatform === "android"
  );
}

/**
 * 인앱 스토어 리뷰 요청. 네이티브에서만 동작(웹은 no-op).
 * 1) npm core 프록시 시도 → 실패 시 2) 주입 브릿지 직접 호출(원격 로드 dual-instance 우회).
 * 실제 노출 여부/빈도는 OS(Apple·Play)가 자체 제한한다.
 */
export async function requestAppReview(): Promise<void> {
  if (!(await detectNativeRuntime())) return;
  try {
    await AppReview.requestReview();
  } catch (coreErr) {
    const nativePlugin = getInjectedCapacitor()?.Plugins?.AppReview;
    if (nativePlugin?.requestReview) {
      try {
        await nativePlugin.requestReview();
      } catch (winErr) {
        console.warn("[app-review] native requestReview failed (both paths)", coreErr, winErr);
      }
    } else {
      console.warn("[app-review] native requestReview failed", coreErr);
    }
  }
}
