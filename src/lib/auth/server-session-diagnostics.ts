import type { NextFetchEvent } from "next/server";
import { authErrorMetadata } from "./session-diagnostic-schema";

type ResponseCookie = {
  name: string;
  value: string;
  maxAge?: number;
  expires?: number | Date;
};

/** Request-local observer for document proxy only; never retains cookie values/UA. */
export function createServerSessionDiagnostics(
  supabaseUrl: string,
  incomingNames: string[],
  userAgent: string,
) {
  const prefix = `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
  const matches = (name: string) => name === prefix ||
    (name.startsWith(prefix + ".") && /^\d+$/.test(name.slice(prefix.length + 1)));
  const incoming = new Set(incomingNames.filter(matches));
  const os = /iPhone|iPad|iPod/.test(userAgent) ? "ios" : /Android/i.test(userAgent) ? "android" : "other";
  let recorded = false;

  return {
    /** Inspect the FINAL response, so chunk cleanup during rotation is not logout. */
    record(cookies: ResponseCookie[], error: unknown, event: NextFetchEvent) {
      try {
        if (recorded || incoming.size === 0) return;
        const remaining = new Set(incoming);
        let deleted = 0;
        for (const cookie of cookies) {
          if (!matches(cookie.name)) continue;
          if (cookie.maxAge === 0 || (cookie.expires != null && Number(cookie.expires) <= Date.now())) {
            remaining.delete(cookie.name);
            deleted++;
          } else if (cookie.value) {
            remaining.add(cookie.name);
          }
        }
        if (!deleted || remaining.size !== 0) return;
        recorded = true;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!key) return;
        const message = JSON.stringify({
          v: 1, event: "auth-cookie-cleared", scope: "document-proxy", os,
          incomingAuth: Math.min(9, incoming.size), deletedAuth: Math.min(9, deleted),
          ...authErrorMetadata(error),
        });
        // No public ingestion path for this source; no request IDs, URL, cookies,
        // raw error text, IP, account, app version or native-platform inference.
        const row = {
          source: "auth-session-server", digest: "auth-session-server-v1", message,
          path: null, stack: null, user_agent: null, visitor_id: null,
          app_version: null, platform: null, is_chunk_error: false,
        };
        // Defer work off the auth path. Lifetime is bounded even if the DB stalls.
        event.waitUntil(Promise.resolve().then(async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 1500);
          try {
            await fetch(`${supabaseUrl}/rest/v1/admin_client_errors`, {
              method: "POST", credentials: "omit", cache: "no-store",
              headers: { "content-type": "application/json", apikey: key, Authorization: `Bearer ${key}`, Prefer: "return=minimal" },
              body: JSON.stringify(row), signal: controller.signal,
            });
          } catch { /* observation failure must not affect auth or leak error text */ }
          finally { clearTimeout(timer); }
        }).catch(() => {}));
      } catch { /* best effort: preserve the original response even if observation fails */ }
    },
  };
}
