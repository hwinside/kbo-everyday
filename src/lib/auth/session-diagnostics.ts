"use client";

import { AUTH_DIAGNOSTIC_SOURCE, authErrorMetadata, parseAuthDiagnostic, type AuthDiagnostic, type AuthStorageObservation } from "./session-diagnostic-schema";

const ENDPOINT = "/api/telemetry/client-error";
const MAX_EVENTS_PER_PAGE = 4;
const unknownStorage = (): AuthStorageObservation => ({ auth: null, otherAuth: null, ga: null, marker: null });
type NativeBridge = { getPlatform?: () => string; isNativePlatform?: () => boolean; Plugins?: { App?: { getInfo?: () => Promise<{ version: string; build: string }> } } };
const bridge = () => (window as unknown as { Capacitor?: NativeBridge }).Capacitor;
const safe = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };

/** Independent observer state. No auth SDK calls, storage writes, or body/header reads. */
export function createAuthSessionDiagnostics() {
  let prefix = "";
  let origin = "";
  let initial = unknownStorage();
  let boot: string | null = null;
  let transport: typeof fetch | null = null;
  let intentionalLogout = false;
  let failed = false;
  // An offline failure's beacon may fail too. Carry its sanitized category into
  // the later recovery observation; never retain the Error, request, or tokens.
  let lastFailure: Pick<AuthDiagnostic, "status" | "error" | "code"> = { status: null, error: null, code: null };
  const seen = new Set<string>();
  const pendingReads = new Set<ReturnType<typeof setTimeout>>();

  function capture(): AuthStorageObservation {
    const state = unknownStorage();
    if (typeof window === "undefined") return state;
    try {
      const names = document.cookie.split(";").map(c => c.split("=", 1)[0].trim());
      const authNames = names.filter(n => /^sb-[a-z0-9-]+-auth-token(?:\.\d+)?$/i.test(n));
      state.auth = Math.min(9, authNames.filter(n => n === prefix || n.startsWith(prefix + ".")).length);
      state.otherAuth = authNames.some(n => n !== prefix && !n.startsWith(prefix + "."));
      state.ga = names.some(n => n === "_ga" || n.startsWith("_ga_"));
    } catch { /* absence must remain distinguishable from denied storage access */ }
    state.marker = safe(() => localStorage.getItem("kbo-auth-uid") !== null, null);
    return state;
  }

  async function appVersion(): Promise<string | null> {
    if (!safe(() => bridge()?.isNativePlatform?.() === true, false)) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const info = safe(() => bridge()?.Plugins?.App?.getInfo, undefined);
      const request = info
        ? bridge()!.Plugins!.App!.getInfo!()
        : import("@capacitor/app").then(({ App }) => App.getInfo());
      const result = await Promise.race([
        request,
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 500); }),
      ]);
      const value = result ? `${result.version} (${result.build})` : "";
      return /^\d{1,3}(?:\.\d{1,3}){1,3} \(\d{1,6}\)$/.test(value) ? value : null;
    } catch { return null; } finally { if (timer) clearTimeout(timer); }
  }

  function emit(event: AuthDiagnostic["event"], before: AuthStorageObservation, session: boolean | null, metadata: Pick<AuthDiagnostic, "status" | "error" | "code">, after = capture()) {
    try {
      if (typeof window === "undefined" || !transport || intentionalLogout) return;
      const key = `${event}:${metadata.status}:${metadata.code}`;
      if (seen.has(key) || seen.size >= MAX_EVENTS_PER_PAGE) return;
      const platform = safe(() => bridge()?.isNativePlatform?.() ? `${bridge()?.getPlatform?.()}_native` : "web", "web");
      const ua = safe(() => navigator.userAgent, "");
      const os = platform === "ios_native" || /iPhone|iPad|iPod/.test(ua) ? "ios" : platform === "android_native" || /Android/.test(ua) ? "android" : "other";
      const diagnostic = parseAuthDiagnostic({ v: 1, boot, event, os, initial, before, after, session, ...metadata });
      if (!diagnostic) return;
      seen.add(key);
      const send = transport;
      // Runs outside the auth callback/lock; the observer can never reject into it.
      void Promise.resolve().then(async () => {
        const body = JSON.stringify({
          source: AUTH_DIAGNOSTIC_SOURCE, message: JSON.stringify(diagnostic),
          appVersion: await appVersion(), platform,
          // Deliberately omit identity, visitor ID, raw UA, URL/query/hash, stack.
        });
        await send(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true, credentials: "omit" });
      }).catch(() => {});
    } catch { /* best effort: no diagnostic may change auth behavior */ }
  }

  function observeFetch(supabaseUrl: string, fetcher: typeof fetch): typeof fetch {
    if (typeof window === "undefined") return fetcher;
    const base = safe(() => new URL(supabaseUrl), null);
    if (!base) return fetcher;
    origin = base.origin;
    prefix = `sb-${base.hostname.split(".")[0]}-auth-token`;
    transport = fetcher;
    initial = capture();
    boot = safe(() => crypto.randomUUID(), null);
    return async (input, init) => {
      const isToken = safe(() => {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(raw, window.location.origin);
        return url.origin === origin && url.pathname === "/auth/v1/token";
      }, false);
      if (!isToken) return fetcher(input, init);
      const before = capture();
      try {
        const response = await fetcher(input, init);
        const status = safe(() => response.status, 0);
        if (status >= 400) {
          failed = true;
          lastFailure = { status, error: null, code: null };
          emit("token-http-error", before, null, lastFailure);
        }
        // Do not read/clone the response body: success bodies contain credentials.
        return response;
      } catch (error) {
        failed = true;
        lastFailure = authErrorMetadata(error);
        emit("token-network-error", before, null, lastFailure);
        throw error;
      }
    };
  }

  function sessionRead(before: AuthStorageObservation, present: boolean, error: unknown) {
    const after = capture();
    if (error) {
      failed = true;
      lastFailure = authErrorMetadata(error);
      emit("session-read-error", before, present, lastFailure, after);
    } else if (!present && after.auth === 0 && ((initial.auth ?? 0) > 0 || (before.auth ?? 0) > 0)) {
      failed = true;
      emit("storage-disappeared", before, false, lastFailure, after);
    } else if (!present && (initial.marker || initial.otherAuth || (before.auth ?? 0) > 0 || (initial.auth ?? 0) > 0)) {
      // Marker may survive an intentional logout in an earlier page session.
      // This is an observation, NOT proof that storage was lost.
      emit("initial-no-session", before, false, { status: null, error: null, code: null }, after);
    } else if (present && failed) {
      emit("recovered", before, true, lastFailure, after);
    }
  }

  function beginSessionRead() {
    const before = capture();
    if (typeof window === "undefined") return { before, finish: () => {} };
    const timer = setTimeout(() => {
      pendingReads.delete(timer);
      emit("session-read-pending", before, null, { status: null, error: null, code: null });
    }, 10_000);
    pendingReads.add(timer);
    return { before, finish: () => { clearTimeout(timer); pendingReads.delete(timer); } };
  }
  function cancelPendingReads() {
    for (const timer of pendingReads) clearTimeout(timer);
    pendingReads.clear();
  }
  return {
    capture, observeFetch, sessionRead, beginSessionRead, cancelPendingReads,
    intentionalLogout: () => { intentionalLogout = true; cancelPendingReads(); },
  };
}

export const authSessionDiagnostics = createAuthSessionDiagnostics();
