import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { AUTH_DIAGNOSTIC_SOURCE, parseAuthDiagnostic } from "@/lib/auth/session-diagnostic-schema";

interface ClientErrorPayload {
  message?: string;
  stack?: string | null;
  source?: string;
  digest?: string | null;
  path?: string | null;
  platform?: string | null;
  appVersion?: string | null;
  userAgent?: string | null;
  visitorId?: string | null;
  isChunkError?: boolean;
}

const VALID_SOURCES = new Set([
  AUTH_DIAGNOSTIC_SOURCE,
  "window-error",
  "unhandledrejection",
  "error-boundary",
  "global-error-boundary",
]);

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.slice(0, max) : null;
}

export async function POST(req: NextRequest) {
  let payload: ClientErrorPayload;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  let message = str(payload.message, 500);
  const source =
    typeof payload.source === "string" && VALID_SOURCES.has(payload.source)
      ? payload.source
      : null;

  // Quietly drop garbage — telemetry beacons must never surface as errors.
  if (!message || !source) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const authDiagnostic = source === AUTH_DIAGNOSTIC_SOURCE;
  if (authDiagnostic) {
    let value: unknown;
    try { value = JSON.parse(message); } catch { value = null; }
    const diagnostic = parseAuthDiagnostic(value);
    if (!diagnostic) return NextResponse.json({ ok: true, skipped: true });
    message = JSON.stringify(diagnostic);
  }

  const diagnosticPlatform = typeof payload.platform === "string" && ["ios_native", "android_native", "web", "pwa"].includes(payload.platform) ? payload.platform : null;
  const diagnosticVersion = typeof payload.appVersion === "string" && /^\d{1,3}(?:\.\d{1,3}){1,3} \(\d{1,6}\)$/.test(payload.appVersion) ? payload.appVersion : null;

  const { error } = await supabase.from("admin_client_errors").insert({
    message,
    stack: authDiagnostic ? null : str(payload.stack, 4000),
    source,
    digest: authDiagnostic ? "auth-session-v1" : str(payload.digest, 128),
    path: authDiagnostic ? null : str(payload.path, 512),
    platform: authDiagnostic ? diagnosticPlatform : str(payload.platform, 32),
    app_version: authDiagnostic ? diagnosticVersion : str(payload.appVersion, 64),
    user_agent: authDiagnostic ? null : str(payload.userAgent, 512),
    visitor_id: authDiagnostic ? null : str(payload.visitorId, 64),
    is_chunk_error: authDiagnostic ? false : payload.isChunkError === true,
  });

  if (error) {
    console.error("[client-error] insert failed:", error.message);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
