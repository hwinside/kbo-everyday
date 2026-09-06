import { getClientIp } from "@/lib/http/client-ip";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { hasAdminPinConfig, verifyAdminPinValue } from "@/lib/admin/pin";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_MAX_AGE_SECONDS,
  createAdminSession,
  getAdminSessionTokenFromRequest,
  verifyAdminSessionToken,
} from "@/lib/admin/session";

const MAX_BACKOFF_SECONDS = 15 * 60;

export async function POST(req: NextRequest) {
  const { pin } = await req.json().catch(() => ({}));

  if (!hasAdminPinConfig()) {
    return NextResponse.json({ error: "ADMIN_PIN not configured" }, { status: 500 });
  }

  // 세션 쿠키만으로도 재인증 가능 (PIN 재입력 없이 앱/탭 재진입, 2026-07-18)
  if (typeof pin !== "string" || !pin) {
    const sessionToken = getAdminSessionTokenFromRequest(req);
    if (sessionToken && (await verifyAdminSessionToken(sessionToken))) {
      return NextResponse.json({ ok: true, via: "session" });
    }
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
    // 기기별 세션 발급 → HttpOnly 쿠키 (PIN 원문은 클라에 저장되지 않음, 2026-07-18)
    // 세션 생성 실패 = fail closed 5xx (2차 리뷰 추가: ok:true로 200 주면 UI가 인증 완료로 오인)
    const token = await createAdminSession(req.headers.get("user-agent"));
    if (!token) {
      return NextResponse.json({ error: "Failed to create session" }, { status: 500 });
    }
    const res = NextResponse.json({ ok: true, via: "pin" });
    res.cookies.set(ADMIN_SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
    });
    return res;
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
