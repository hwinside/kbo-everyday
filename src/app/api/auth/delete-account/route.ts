import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUserIdFromCookies } from "@/lib/auth/verified-user";

export async function POST() {
  const cookieStore = await cookies();

  // 쿠키 직접파싱 → dead-token guard 경유(만료/폐기 세션은 /auth/v1/user에
  // 도달하지 않음). supabase-js 서버 클라 제거 — refresh 유발 0.
  const userId = await getVerifiedUserIdFromCookies();

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
