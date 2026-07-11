import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";

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

  const message = str(payload.message, 500);
  const source =
    typeof payload.source === "string" && VALID_SOURCES.has(payload.source)
      ? payload.source
      : null;

  // Quietly drop garbage — telemetry beacons must never surface as errors.
  if (!message || !source) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const { error } = await supabase.from("admin_client_errors").insert({
    message,
    stack: str(payload.stack, 4000),
    source,
    digest: str(payload.digest, 128),
    path: str(payload.path, 512),
    platform: str(payload.platform, 32),
    app_version: str(payload.appVersion, 64),
    user_agent: str(payload.userAgent, 512),
    visitor_id: str(payload.visitorId, 64),
    is_chunk_error: payload.isChunkError === true,
  });

  if (error) {
    console.error("[client-error] insert failed:", error.message);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
