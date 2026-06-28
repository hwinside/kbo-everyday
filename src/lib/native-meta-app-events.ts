import { registerPlugin } from "@capacitor/core";

interface MetaAppEventsPlugin {
  logEvent(options: {
    name: string;
    parameters?: Record<string, string | number | boolean>;
  }): Promise<void>;
}

const MetaAppEvents = registerPlugin<MetaAppEventsPlugin>("MetaAppEvents");

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
    if (!Capacitor.isNativePlatform()) return;

    await MetaAppEvents.logEvent({
      name,
      parameters: normalizeParameters(properties),
    });
  } catch (error) {
    console.warn("[analytics] Native Meta App Event failed", error);
  }
}
