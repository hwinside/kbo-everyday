import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { hasAdminPinConfig, verifyAdminPinValue } from "@/lib/admin/pin";

const MAX_BACKOFF_SECONDS = 15 * 60;

function getClientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function getSupabaseAdmin() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return null;

  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey,
  );
}

export async function POST(req: NextRequest) {
  const { pin } = await req.json().catch(() => ({}));

  if (!hasAdminPinConfig()) {
    return NextResponse.json({ error: "ADMIN_PIN not configured" }, { status: 500 });
  }

  if (typeof pin !== "string" || !pin) {
    return NextResponse.json({ error: "PIN required" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json({ error: "Admin auth unavailable" }, { status: 500 });
  }

  const ip = getClientIp(req);
  const now = new Date();

  const { data: attemptRow, error: attemptError } = await supabase
    .from("admin_auth_attempts")
    .select("failed_attempts, blocked_until")
    .eq("ip_address", ip)
    .maybeSingle();

  if (attemptError) {
    return NextResponse.json({ error: "Failed to check rate limit" }, { status: 500 });
  }

  const blockedUntil = attemptRow?.blocked_until ? new Date(attemptRow.blocked_until) : null;
  if (blockedUntil && blockedUntil > now) {
    const retryAfterSec = Math.max(1, Math.ceil((blockedUntil.getTime() - now.getTime()) / 1000));
    return NextResponse.json(
      { error: "Too many attempts. Try again later.", retryAfterSec },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfterSec) },
      },
    );
  }

  if (verifyAdminPinValue(pin)) {
    await supabase.from("admin_auth_attempts").delete().eq("ip_address", ip);
    return NextResponse.json({ ok: true });
  }

  const failedAttempts = (attemptRow?.failed_attempts ?? 0) + 1;
  const retryAfterSec = Math.min(2 ** Math.max(failedAttempts - 1, 0), MAX_BACKOFF_SECONDS);
  const nextBlockedUntil = new Date(now.getTime() + retryAfterSec * 1000).toISOString();

  const { error: upsertError } = await supabase
    .from("admin_auth_attempts")
    .upsert({
      ip_address: ip,
      failed_attempts: failedAttempts,
      blocked_until: nextBlockedUntil,
      last_failed_at: now.toISOString(),
      updated_at: now.toISOString(),
    }, { onConflict: "ip_address" });

  if (upsertError) {
    return NextResponse.json({ error: "Failed to record auth attempt" }, { status: 500 });
  }

  return NextResponse.json(
    { error: "Invalid PIN", retryAfterSec },
    {
      status: 401,
      headers: { "Retry-After": String(retryAfterSec) },
    },
  );
}
