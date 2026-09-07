"use client";

import type { AuthStorageObservation } from "./session-diagnostic-schema";
import { AUTH_EXIT_MAX_AGE_MINUTES, AUTH_EXIT_MAX_CHARS, parseAuthExitRecord, type AuthExitRecord, type PreviousAuthExit } from "./previous-exit-schema";

/** This diagnostic-only key never feeds session restoration. Shared-origin tabs
 * can replace it; pagehide can be skipped; storage can disappear with the record.
 * Thus neither missing (even repeatedly) nor before/after differences prove loss.
 * Captured once before this document writes, so the current boot cannot masquerade
 * as its own predecessor. No tokens, account IDs, boot IDs, URLs, or Error values. */
export function createPreviousExitTracker(prefix: string, capture: () => AuthStorageObservation) {
  const key = `kbo-auth-prev-exit-v1:${prefix}`;
  const now = () => Math.floor(Date.now() / 60_000);
  function read(): PreviousAuthExit {
    let raw: string | null;
    try { raw = localStorage.getItem(key); } catch { return { state: "unreadable", record: null }; }
    if (raw === null) return { state: "missing", record: null };
    if (raw.length > AUTH_EXIT_MAX_CHARS) return { state: "invalid", record: null };
    try {
      const record = parseAuthExitRecord(JSON.parse(raw));
      if (!record || record.at > now() + 5) return { state: "invalid", record: null };
      if (now() - record.at > AUTH_EXIT_MAX_AGE_MINUTES) return { state: "expired", record: null };
      return { state: "present", record };
    } catch { return { state: "invalid", record: null }; }
  }
  const previous = read();
  let lastRefresh: AuthExitRecord["lastRefresh"] = previous.record?.lastRefresh ?? "none";
  let lastRefreshAt: number | null = previous.record?.lastRefreshAt ?? null;
  let intentional = previous.record?.kind === "logout";
  let authenticated = false;
  let lifecycleMinute: number | null = null;
  let lastSerialized = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let listening = false;

  function write(kind: AuthExitRecord["kind"]) {
    try {
      if (intentional && kind !== "logout") return;
      const at = now();
      const state = capture();
      if (kind !== "logout" && !authenticated && !(state.auth ?? 0) && !state.marker && lastRefresh === "none") return;
      if ((kind === "hidden" || kind === "pagehide") && lifecycleMinute === at) return;
      const record = parseAuthExitRecord({ v: 1, at, kind, authChunks: state.auth, marker: state.marker, lastRefresh, lastRefreshAt });
      if (!record) return;
      const serialized = JSON.stringify(record);
      if (serialized === lastSerialized) return;
      localStorage.setItem(key, serialized);
      lastSerialized = serialized;
      if (kind === "hidden" || kind === "pagehide") lifecycleMinute = at;
    } catch { /* Denied/quota/detached storage must never reject auth or navigation. */ }
  }
  const hidden = () => { if (document.visibilityState === "hidden") write("hidden"); };
  const pagehide = () => write("pagehide");
  function start() {
    if (listening) return;
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", pagehide);
    listening = true;
  }
  function stop() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    document.removeEventListener("visibilitychange", hidden);
    window.removeEventListener("pagehide", pagehide);
    listening = false;
  }
  return {
    previous, start, stop,
    refreshFailed() { lastRefresh = "fail"; lastRefreshAt = now(); },
    sessionEstablished(refreshed: boolean) {
      intentional = false;
      authenticated = true;
      if (refreshed) { lastRefresh = "ok"; lastRefreshAt = now(); }
      // SDK callbacks are awaited under an auth lock. Storage I/O runs later.
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; write(refreshed ? "refresh" : "session"); }, 0);
    },
    logout() {
      stop();
      intentional = true;
      // Intent, not signOut success. Preserve it across new documents so a
      // surviving old marker cannot silently turn intentional logout into loss.
      write("logout");
    },
  };
}
