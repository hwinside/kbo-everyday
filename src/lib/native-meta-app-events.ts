import { registerPlugin } from "@capacitor/core";

interface MetaAppEventsPlugin {
  logEvent(options: {
    name: string;
    parameters?: Record<string, string | number | boolean>;
  }): Promise<void>;
}

const MetaAppEvents = registerPlugin<MetaAppEventsPlugin>("MetaAppEvents");

// 주입된 네이티브 브릿지(window.Capacitor) 타입 — 원격 로드(server.url) 시 npm @capacitor/core가
// 'web'으로 오판하는 케이스를 우회하기 위해 직접 접근한다.
interface InjectedCapacitor {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: {
    MetaAppEvents?: {
      logEvent?: (o: { name: string; parameters?: Record<string, string | number | boolean> }) => Promise<void>;
    };
  };
}

function getInjectedCapacitor(): InjectedCapacitor | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { Capacitor?: InjectedCapacitor }).Capacitor;
}

function normalizeParameters(properties?: Record<string, unknown>): Record<string, string | number | boolean> {
  const parameters: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parameters[key] = value;
    }
  }
  return parameters;
}

export async function logNativeMetaEvent(
  name: string,
  properties?: Record<string, unknown>,
): Promise<void> {
  const parameters = normalizeParameters(properties);

  // npm core 판정 (원격 로드 시 'web'으로 오판 가능)
  let coreNative: boolean | undefined;
  let platform: string | undefined;
  try {
    const { Capacitor } = await import("@capacitor/core");
    coreNative = Capacitor.isNativePlatform();
    platform = Capacitor.getPlatform?.();
  } catch {
    /* core 로드 실패 무시 */
  }

  // 주입된 네이티브 브릿지(원격 로드 dual-instance 우회) 판정
  const injected = getInjectedCapacitor();
  let bridgeNative: boolean | undefined;
  try {
    bridgeNative = injected?.isNativePlatform?.();
  } catch {
    /* 무시 */
  }
  let injectedPlatform: string | undefined;
  try {
    injectedPlatform = injected?.getPlatform?.();
  } catch {
    /* 무시 */
  }

  // npm core 또는 주입 브릿지 어느 쪽이든 native면 진행. 웹에선 모두 false → no-op.
  const isNative =
    coreNative === true ||
    bridgeNative === true ||
    platform === "ios" ||
    platform === "android" ||
    injectedPlatform === "ios" ||
    injectedPlatform === "android";

  if (!isNative) return;

  // 1) npm core 프록시 시도 → 실패 시 2) 주입 브릿지 직접 호출(원격 로드 dual-instance 우회)
  try {
    await MetaAppEvents.logEvent({ name, parameters });
  } catch (coreErr) {
    const nativePlugin = injected?.Plugins?.MetaAppEvents;
    if (nativePlugin?.logEvent) {
      try {
        await nativePlugin.logEvent({ name, parameters });
      } catch (winErr) {
        console.warn("[analytics] Native Meta App Event failed (both paths)", coreErr, winErr);
      }
    } else {
      console.warn("[analytics] Native Meta App Event failed", coreErr);
    }
  }
}
