import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

// Always redirect to the canonical domain so iOS PWA doesn't end up
// in the Vercel preview URL after OAuth.
const CANONICAL_ORIGIN =
  process.env.NEXT_PUBLIC_SITE_URL || "https://keubo.fan";

function buildRedirectWithCookies(
  url: string,
  pendingCookies: { name: string; value: string; options: any }[]
): NextResponse {
  const response = NextResponse.redirect(url);
  for (const { name, value, options } of pendingCookies) {
    response.cookies.set(name, value, {
      ...options,
      // Supabase 세션 쿠키 기본값 보장 (path 누락 시 /auth/callback 한정으로 유실됨)
      path: (options?.path as string) || "/",
      sameSite: (options?.sameSite as "lax" | "strict" | "none") || "lax",
      httpOnly: (options?.httpOnly as boolean) ?? false,
      secure: process.env.NODE_ENV !== "development",
    });
  }
  return response;
}

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");

  // 세션 쿠키를 redirect 응답에 확실히 실기 위해 수집
  const pendingCookies: { name: string; value: string; options: any }[] = [];

  if (code) {
    const cookieStore = await cookies();

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
              pendingCookies.push({ name, value, options });
            });
          },
        },
      }
    );

    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.error("[auth/callback] exchangeCodeForSession failed:", error.message, error);
      const errorUrl = new URL(CANONICAL_ORIGIN);
      errorUrl.searchParams.set("auth_error", error.message);
      return NextResponse.redirect(errorUrl.toString());
    }

    // 서버사이드에서 프로필 존재 여부 확인 → 없으면 /setup으로 직접 이동
    // 클라이언트 모달에 의존하지 않으므로 쿠키/세션 상태와 무관하게 확실히 동작
    if (data.user) {
      try {
        const admin = getSupabaseAdmin();
        const { data: profile } = await admin
          .from("profiles")
          .select("id, nickname, team_id")
          .eq("id", data.user.id)
          .maybeSingle();

        const needsSetup = !profile || !profile.nickname || !profile.team_id;

        // 세션 토큰을 URL hash로 전달 — 쿠키가 안 붙더라도 클라이언트에서 setSession() 가능
        const session = data.session;
        const hashParams = session
          ? `#access_token=${session.access_token}&refresh_token=${session.refresh_token}&type=recovery`
          : "";

        const redirectUrl = needsSetup
          ? `${CANONICAL_ORIGIN}/setup${hashParams}`
          : `${CANONICAL_ORIGIN}${hashParams}`;

        console.log("[auth/callback]", {
          userId: data.user.id.slice(0, 8),
          email: data.user.email,
          hasProfile: !!profile,
          needsSetup,
          hasHash: !!hashParams,
          cookieCount: pendingCookies.length,
        });

        return buildRedirectWithCookies(redirectUrl, pendingCookies);
      } catch (e) {
        console.error("[auth/callback] profile check failed:", e);
        // 프로필 체크 실패해도 홈으로는 보냄
        return buildRedirectWithCookies(CANONICAL_ORIGIN, pendingCookies);
      }
    }

    return buildRedirectWithCookies(CANONICAL_ORIGIN, pendingCookies);
  } else {
    console.warn("[auth/callback] No code parameter in callback URL");
  }

  return NextResponse.redirect(CANONICAL_ORIGIN);
}
