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

// TEMP 진단(2026-06-28): 네이티브 Meta 이벤트 브릿지가 런타임에 실제 닿는지 서버로 비콘 전송.
// 페이지 로드 단위 추적 id (가입 1회 내 단계들을 묶어 보기 위함)
const NATIVE_META_TRACE_ID =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : String(Date.now()).slice(-8);

// keepalive로 hard navigation 후에도 전송 보장. 원인 확정 후 제거.
function sendBeacon(stage: string, eventName: string | null, detail: string | null): void {
  try {
    fetch("/api/debug/native-meta-beacon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({ traceId: NATIVE_META_TRACE_ID, stage, eventName, detail, platform: "app" }),
    }).catch(() => {});
  } catch {
    /* 진단용 — 실패 무시 */
  }
}

export async function logNativeMetaEvent(
  name: string,
  properties?: Record<string, unknown>,
): Promise<void> {
  const parameters = normalizeParameters(properties);

  // npm core 판정
  let coreNative: boolean | undefined;
  let platform: string | undefined;
  try {
    const { Capacitor } = await import("@capacitor/core");
    coreNative = Capacitor.isNativePlatform();
    platform = Capacitor.getPlatform?.();
  } catch {
    /* core 로드 실패 무시 */
  }

  // 주입된 네이티브 브릿지(원격 로드 우회) 판정
  const injected = getInjectedCapacitor();
  const hasInjected = !!injected;
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

  sendBeacon(
    "attempt",
    name,
    `core=${coreNative},bridge=${bridgeNative},plat=${platform},injPlat=${injectedPlatform},winCap=${hasInjected}`,
  );

  // 네이티브 여부: npm core 또는 주입 브릿지 어느 쪽이든 native면 진행.
  const isNative =
    coreNative === true ||
    bridgeNative === true ||
    platform === "ios" ||
    platform === "android" ||
    injectedPlatform === "ios" ||
    injectedPlatform === "android";

  if (!isNative) {
    sendBeacon("skip_non_native", name, `plat=${platform},injPlat=${injectedPlatform}`);
    return;
  }

  // 1) npm core 프록시 시도 → 실패 시 2) 주입 브릿지 직접 호출(원격 로드 dual-instance 우회)
  try {
    await MetaAppEvents.logEvent({ name, parameters });
    sendBeacon("bridge_resolved", name, "via=core");
  } catch (coreErr) {
    const nativePlugin = injected?.Plugins?.MetaAppEvents;
    if (nativePlugin?.logEvent) {
      try {
        await nativePlugin.logEvent({ name, parameters });
        sendBeacon("bridge_resolved", name, "via=winCap");
      } catch (winErr) {
        sendBeacon("bridge_rejected", name, `core:${String(coreErr).slice(0, 140)}|win:${String(winErr).slice(0, 140)}`);
        console.warn("[analytics] Native Meta App Event failed (both paths)", coreErr, winErr);
      }
    } else {
      sendBeacon("bridge_rejected", name, `core:${String(coreErr).slice(0, 180)}|noWinPlugin`);
      console.warn("[analytics] Native Meta App Event failed", coreErr);
    }
  }
}
