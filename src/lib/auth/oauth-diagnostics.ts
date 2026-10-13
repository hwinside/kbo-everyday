"use client";
import { isNative, isNativeRuntime, isIosNativeRuntime } from "@/lib/capacitor/platform";
import { OAUTH_DIAGNOSTIC_SOURCE, OAUTH_PROVIDERS, parseOAuthDiagnostic, type OAuthDiagnostic, type OAuthProvider } from "./oauth-diagnostic-schema";
const KEY = "kbo-oauth-attempt-v1";
type Attempt = { id: string; provider: OAuthProvider; at: number };
let current: Attempt | null = null;
let listener = false;
let bridge = false;
let count = 0;
const seen = new Set<string>();
function attempt(): Attempt | null {
  if (typeof window === "undefined") return null;
  try {
    if (!current) {
      const x = JSON.parse(sessionStorage.getItem(KEY) || "null");
      if (x && typeof x.id === "string" && OAUTH_PROVIDERS.includes(x.provider) && typeof x.at === "number") current = x;
    }
    if (current && (Date.now() - current.at > 15 * 60_000 || current.at > Date.now())) { current = null; sessionStorage.removeItem(KEY); }
  } catch { /* storage denial must not break OAuth */ }
  return current;
}
export function beginOAuthAttempt(provider: OAuthProvider): void {
  try {
    current = { id: crypto.randomUUID(), provider, at: Date.now() };
    try { sessionStorage.setItem(KEY, JSON.stringify(current)); } catch { /* memory-only */ }
    observeOAuth("start");
  } catch { /* diagnostic-only */ }
}
export function setOAuthBridgeReady(ready: boolean): void {
  bridge = ready;
  observeOAuth(ready ? "bridge-ready" : "bridge-failed");
}
export function setOAuthListenerReady(ready: boolean): void {
  listener = ready;
  observeOAuth(ready ? "listener-ready" : "listener-skipped");
}
async function appVersion(): Promise<string | null> {
  if (!isNativeRuntime()) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const info = await Promise.race([
      import("@capacitor/app").then(({ App }) => App.getInfo()),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 500); }),
    ]);
    const version = info ? `${info.version} (${info.build})` : "";
    return /^\d{1,3}(?:\.\d{1,3}){1,3} \(\d{1,6}\)$/.test(version) ? version : null;
  } catch { return null; } finally { if (timer) clearTimeout(timer); }
}
export function observeOAuth(stage: OAuthDiagnostic["stage"], failure: OAuthDiagnostic["failure"] = "none"): void {
  try {
    if (typeof window === "undefined" || count >= 32) return;
    const a = attempt();
    // Profile renders unrelated to a recent OAuth attempt are not observations.
    if (!a && (stage === "profile-ready" || stage === "profile-required")) return;
    const record = parseOAuthDiagnostic({ v: 1, attempt: a?.id ?? null, provider: a?.provider ?? "unknown", stage, failure, coreNative: isNative, runtimeNative: isNativeRuntime(), listener, bridge });
    if (!record) return;
    const key = `${record.attempt}:${stage}:${failure}`;
    if (seen.has(key)) return;
    seen.add(key); count++;
    const platform = isNativeRuntime() ? isIosNativeRuntime() ? "ios_native" : "android_native" : "web";
    // Never await from an auth callback. Diagnostic failure cannot reject into SDK.
    void Promise.resolve().then(async () => {
      const body = JSON.stringify({ source: OAUTH_DIAGNOSTIC_SOURCE, message: JSON.stringify(record), platform, appVersion: await appVersion() });
      await fetch("/api/telemetry/client-error", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true, credentials: "omit" });
    }).catch(() => {});
  } catch { /* observer isolation */ }
}
