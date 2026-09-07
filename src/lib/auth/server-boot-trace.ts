import type { NextFetchEvent, NextResponse } from "next/server";
import { AUTH_BOOT_SERVER_SOURCE, AUTH_BOOT_TIMING } from "./boot-trace-schema";
import { authErrorMetadata } from "./session-diagnostic-schema";

/** Sample 1/32 of iOS document requests. The ID lives for ONE response, not a
 * device/session. No-cookie arrivals are sampled too: they are the missing step
 * in initial-no-session reports. No sampling inference from missing rows. */
export function createServerBootTrace(supabaseUrl: string, incomingNames: string[], userAgent: string) {
  let boot: string | null = null;
  let prefix = "";
  try { prefix = `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`; } catch { /* invalid configuration: no trace */ }
  const matches = (name: string) => name === prefix ||
    (name.startsWith(prefix + ".") && /^\d+$/.test(name.slice(prefix.length + 1)));
  const incoming = new Set(incomingNames.filter(matches));
  try {
    if (prefix && process.env.VERCEL_ENV === "production" && process.env.SUPABASE_SERVICE_ROLE_KEY && /iPhone|iPad|iPod/.test(userAgent)
      && crypto.getRandomValues(new Uint8Array(1))[0] < 8) boot = crypto.randomUUID();
  } catch { /* Sampling failure must not change auth or the response. */ }
  let recorded = false;
  return {
    record(response: NextResponse, error: unknown, event: NextFetchEvent): NextResponse {
      try {
        if (!boot || recorded) return response;
        recorded = true;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!key) return response;
        const remaining = new Set(incoming);
        let deleted = 0;
        let written = 0;
        for (const cookie of response.cookies.getAll()) {
          if (!matches(cookie.name)) continue;
          if (cookie.maxAge === 0 || (cookie.expires != null && Number(cookie.expires) <= Date.now())) {
            remaining.delete(cookie.name);
            deleted++;
          } else if (cookie.value) {
            remaining.add(cookie.name);
            written++;
          }
        }
        const row = {
          source: AUTH_BOOT_SERVER_SOURCE, digest: "auth-boot-server-v1",
          message: JSON.stringify({
            v: 1, boot, event: "document-response", os: "ios", sample: 32,
            incomingAuth: Math.min(9, incoming.size), deletedAuth: Math.min(9, deleted),
            writtenAuth: Math.min(9, written), remainingAuth: Math.min(9, remaining.size),
            ...authErrorMetadata(error),
          }),
          path: null, stack: null, user_agent: null, visitor_id: null,
          app_version: null, platform: null, is_chunk_error: false,
        };
        // Public/full-route caches must not reuse another document's join ID.
        // Unselected requests retain their original cache policy and headers.
        response.headers.append("Server-Timing", `${AUTH_BOOT_TIMING};desc="${boot}"`);
        response.headers.set("Cache-Control", "private, no-store");
        response.headers.set("Vercel-CDN-Cache-Control", "no-store");
        event.waitUntil(Promise.resolve().then(async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 1500);
          try {
            await fetch(`${supabaseUrl}/rest/v1/admin_client_errors`, {
              method: "POST", credentials: "omit", cache: "no-store",
              headers: { "content-type": "application/json", apikey: key, Authorization: `Bearer ${key}`, Prefer: "return=minimal" },
              body: JSON.stringify(row), signal: controller.signal,
            });
          } catch { /* Missing row is unknown, never evidence of no deletion. */ }
          finally { clearTimeout(timer); }
        }).catch(() => {}));
      } catch { /* No diagnostic may reject the document response. */ }
      return response;
    },
  };
}
