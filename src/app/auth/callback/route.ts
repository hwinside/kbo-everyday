import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  getUserFacingAuthError,
  KAKAO_EMAIL_UNVERIFIED_CODE,
} from "@/lib/auth-error";

// Always redirect to the canonical domain so iOS PWA doesn't end up
// in the Vercel preview URL after OAuth.
const CANONICAL_ORIGIN =
  process.env.NEXT_PUBLIC_SITE_URL || "https://keubo.fan";
const IOS_NATIVE_CALLBACK_ORIGIN = "fan.keubo.app://auth/callback";

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
  const isNativeIOS = requestUrl.searchParams.get("native") === "ios";
  const userFacingError = getUserFacingAuthError(requestUrl.searchParams);

  if (userFacingError === KAKAO_EMAIL_UNVERIFIED_CODE) {
    const errorUrl = new URL(CANONICAL_ORIGIN);
    errorUrl.searchParams.set("auth_error", userFacingError);
    return NextResponse.redirect(errorUrl);
  }

  // 진단용 요청 메타 (PKCE 간헐 에러 원인 추적 목적 — 2026-04-18)
  // User-Agent / Referer / x-forwarded-* 기록해 모바일 vs 데스크톱, 출발 페이지 파악 가능하도록.
  const diagnosticMeta = {
    ua: request.headers.get("user-agent")?.slice(0, 220),
    secChUaMobile: request.headers.get("sec-ch-ua-mobile"),
    secChUaPlatform: request.headers.get("sec-ch-ua-platform"),
    referer: request.headers.get("referer")?.slice(0, 200),
    host: request.headers.get("host"),
    xfHost: request.headers.get("x-forwarded-host"),
    xfProto: request.headers.get("x-forwarded-proto"),
  };

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
      // PKCE 에러 등 exchange 실패 시 UA/referer/host 같이 남겨서 모바일여부 및 상이한 온라우저 컨텍스트 파악
      console.error(
        "[auth/callback] exchangeCodeForSession failed:",
        error.message,
        { errorCode: (error as any).code, ...diagnosticMeta },
        error
      );
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

        const webRedirectUrl = needsSetup
          ? `${CANONICAL_ORIGIN}/setup${hashParams}`
          : `${CANONICAL_ORIGIN}${hashParams}`;
        const redirectUrl = isNativeIOS && hashParams
          ? `${IOS_NATIVE_CALLBACK_ORIGIN}?next=${encodeURIComponent(needsSetup ? "/setup" : "/")}${hashParams}`
          : webRedirectUrl;

        console.log("[auth/callback]", {
          userId: data.user.id.slice(0, 8),
          email: data.user.email,
          hasProfile: !!profile,
          needsSetup,
          hasHash: !!hashParams,
          isNativeIOS,
          cookieCount: pendingCookies.length,
          // 진단 메타 (모바일 vs 데스크톱 / apex vs www 통계 용, 1일짜리)
          ...diagnosticMeta,
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
