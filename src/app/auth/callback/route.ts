import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

// Always redirect to the canonical domain so iOS PWA doesn't end up
// in the Vercel preview URL after OAuth.
const CANONICAL_ORIGIN =
  process.env.NEXT_PUBLIC_SITE_URL || "https://keubo.fan";

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");

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
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          },
        },
      }
    );

    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.error("[auth/callback] exchangeCodeForSession failed:", error.message, error);
      // 세션 교환 실패 시 에러 내용을 URL에 포함해서 디버깅 가능하게
      const errorUrl = new URL(CANONICAL_ORIGIN);
      errorUrl.searchParams.set("auth_error", error.message);
      return NextResponse.redirect(errorUrl.toString());
    }
  } else {
    console.warn("[auth/callback] No code parameter in callback URL");
  }

  // Redirect to canonical domain (not requestUrl.origin which can be Vercel URL).
  return NextResponse.redirect(CANONICAL_ORIGIN);
}
