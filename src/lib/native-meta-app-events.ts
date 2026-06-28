import { registerPlugin } from "@capacitor/core";

interface MetaAppEventsPlugin {
  logEvent(options: {
    name: string;
    parameters?: Record<string, string | number | boolean>;
  }): Promise<void>;
}

const MetaAppEvents = registerPlugin<MetaAppEventsPlugin>("MetaAppEvents");

// TEMP 진단(2026-06-28): 네이티브 Meta 이벤트 브릿지가 런타임에 실제 닿는지 서버로 비콘 전송.
// 페이지 로드 단위 추적 id (가입 1회 내 단계들을 묶어 보기 위함)
const NATIVE_META_TRACE_ID =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : String(Date.now()).slice(-8);

// keepalive로 hard navigation 후에도 전송 보장. 원인 확정 후 제거.
function sendBeacon(stage: string, eventName: string | null, detail: string | null): void {
  try {
    const platform = typeof navigator !== "undefined" ? "web-or-native" : "ssr";
    fetch("/api/debug/native-meta-beacon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({ traceId: NATIVE_META_TRACE_ID, stage, eventName, detail, platform }),
    }).catch(() => {});
  } catch {
    /* 진단용 — 실패 무시 */
  }
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
  try {
    const { Capacitor } = await import("@capacitor/core");
    const isNative = Capacitor.isNativePlatform();
    sendBeacon("attempt", name, `isNative=${isNative}`); // TEMP 진단
    if (!isNative) {
      sendBeacon("skip_non_native", name, null); // TEMP 진단
      return;
    }

    await MetaAppEvents.logEvent({
      name,
      parameters: normalizeParameters(properties),
    });
    sendBeacon("bridge_resolved", name, null); // TEMP 진단: 플러그인까지 도달+resolve
  } catch (error) {
    sendBeacon("bridge_rejected", name, String(error).slice(0, 400)); // TEMP 진단: 브릿지 reject
    console.warn("[analytics] Native Meta App Event failed", error);
  }
}
