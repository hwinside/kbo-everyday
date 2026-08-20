import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUserIdFromCookiesLive } from "@/lib/auth/verified-user";

export async function POST() {
  const cookieStore = await cookies();

  // 쿠키 직접파싱 → dead-token guard 경유. supabase-js 서버 클라 제거 — refresh 유발 0.
  // ⚠️ 여기만 Live(서버 왕복) 검증을 쓴다 — 계정 영구 삭제는 되돌릴 수 없으므로
  // 이미 로그아웃/폐기된 세션으로 실행되면 안 된다. 로컬 claim 검증은 exp(3600s)
  // 까지 유효해서 폐기를 못 본다(삼순 blocker②). 저빈도 경로라 CPU 영향 없음.
  const userId = await getVerifiedUserIdFromCookiesLive();

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = getSupabaseAdmin();

  // The auth user is the deletion root. Public tables either cascade their
  // user-owned rows or anonymize telemetry through database constraints.
  // Do not delete the profile first: a failed auth deletion must not leave a
  // signed-in user without a profile.
  const { error } = await admin.auth.admin.deleteUser(userId);

  if (error) {
    console.error("[delete-account] Failed to delete user:", error);
    return NextResponse.json(
      { error: "Failed to delete account" },
      { status: 500 }
    );
  }

  // Clear session cookies
  const allCookies = cookieStore.getAll();
  for (const cookie of allCookies) {
    if (cookie.name.includes("supabase") || cookie.name.includes("sb-")) {
      cookieStore.delete(cookie.name);
    }
  }

  return NextResponse.json({ ok: true });
}
