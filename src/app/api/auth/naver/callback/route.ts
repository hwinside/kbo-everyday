import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

// ⚠️ 2026-04-21 state 쿠키 도메인 불일치 수정 (fryfish P0)
// start route와 callback route가 동일 호스트를 사용해야 쿠키 공유 가능.
// 들어온 요청의 origin(www 혹은 apex)을 그대로 사용 → start와 callback이 항상 일치.
function getOrigin(request: NextRequest) {
  return request.nextUrl.origin;
}

const IOS_NATIVE_CALLBACK_ORIGIN = "fan.keubo.app://auth/callback";

/**
 * 네이버 OAuth 콜백 핸들러
 *
 * 1. code를 네이버 토큰으로 교환
 * 2. 네이버 프로필 API로 유저 정보 조회
 * 3. Supabase admin으로 유저 생성/조회
 * 4. 세션 생성 후 홈으로 redirect
 */
export async function GET(request: NextRequest) {
  const CANONICAL_ORIGIN = getOrigin(request);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const isNativeIOS = url.searchParams.get("native") === "ios";
  const userAgent = request.headers.get("user-agent") || "";
  const referer = request.headers.get("referer") || "";
  // Structured diag log for mobile login triage (2026-04-21)
  console.log("[Naver OAuth][step0] callback hit", {
    hasCode: !!code,
    hasState: !!state,
    error: error || null,
    isMobile: /Mobi|Android|iPhone|iPad/i.test(userAgent),
    isInApp: /Instagram|KAKAOTALK|FBAN|FBAV|Line|NAVER\(inapp/i.test(userAgent),
    uaShort: userAgent.slice(0, 120),
    referer: referer.slice(0, 80),
  });

  // 에러 처리
  if (error) {
    console.error("[Naver OAuth] Error:", error, url.searchParams.get("error_description"));
    return NextResponse.redirect(
      `${CANONICAL_ORIGIN}?login_error=${encodeURIComponent(error)}`
    );
  }

  if (!code) {
    return NextResponse.redirect(
      `${CANONICAL_ORIGIN}?login_error=no_code`
    );
  }

  // CSRF state 검증
  const cookieStore = await cookies();
  // verifyOtp이 설정할 쿠키를 수집 (redirect 응답에 복사하기 위해)
  const pendingCookies: { name: string; value: string; options: any }[] = [];
  const savedState = cookieStore.get("naver_oauth_state")?.value;
  if (!savedState || savedState !== state) {
    console.error("[Naver OAuth][step1] State mismatch", {
      savedState: savedState ? savedState.slice(0, 8) : null,
      stateFromQuery: state ? state.slice(0, 8) : null,
      allCookies: cookieStore.getAll().map((c) => c.name),
      isInApp: /Instagram|KAKAOTALK|FBAN|FBAV|Line|NAVER\(inapp/i.test(userAgent),
    });
    return NextResponse.redirect(
      `${CANONICAL_ORIGIN}?login_error=state_mismatch`
    );
  }

  const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID!;
  const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET!;

  try {
    // 1. 네이버 토큰 교환
    const tokenRes = await fetch("https://nid.naver.com/oauth2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: NAVER_CLIENT_ID,
        client_secret: NAVER_CLIENT_SECRET,
        code,
        state: state || "",
      }),
    });

    const tokenData = await tokenRes.json();
    console.log("[Naver OAuth][step2] token exchange", {
      ok: !tokenData.error,
      hasAccessToken: !!tokenData.access_token,
      error: tokenData.error || null,
    });
    if (tokenData.error) {
      console.error("[Naver OAuth] Token error:", tokenData);
      return NextResponse.redirect(
        `${CANONICAL_ORIGIN}?login_error=token_error`
      );
    }

    const accessToken = tokenData.access_token;

    // 2. 네이버 프로필 조회
    const profileRes = await fetch("https://openapi.naver.com/v1/nid/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const profileData = await profileRes.json();

    if (profileData.resultcode !== "00") {
      console.error("[Naver OAuth] Profile error:", profileData);
      return NextResponse.redirect(
        `${CANONICAL_ORIGIN}?login_error=profile_error`
      );
    }

    const naverProfile = profileData.response;
    const naverId = naverProfile.id;
    const email = naverProfile.email;
    const name = naverProfile.name || naverProfile.nickname || "";
    console.log("[Naver OAuth][step3] profile fetched", {
      hasEmail: !!email,
      naverIdPrefix: naverId ? String(naverId).slice(0, 8) : null,
    });

    if (!email) {
      console.error("[Naver OAuth] No email in profile:", naverProfile);
      return NextResponse.redirect(
        `${CANONICAL_ORIGIN}?login_error=no_email`
      );
    }

    // 3. Supabase admin으로 유저 조회/생성
    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // 이메일로 기존 유저 조회
    //
    // 버그 수정 (2026-04-21): listUsers() 기본 perPage=50이라 655명 중 50명만 조회 →
    // 중간/초기 가입자를 못 찾아 중복 createUser() 시도 → "email already registered" AuthApiError.
    // 해결: email 정규화(소문자+trim) 후 페이지네이션으로 전수 순회.
    const normalizedEmail = String(email).trim().toLowerCase();
    let existingUser: Awaited<ReturnType<typeof supabaseAdmin.auth.admin.listUsers>>["data"]["users"][number] | undefined;
    for (let page = 1; page <= 20; page++) {
      const { data: pageData, error: pageErr } =
        await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
      if (pageErr) {
        console.error("[Naver OAuth] listUsers error:", pageErr.message);
        break;
      }
      const hit = pageData?.users?.find(
        (u) => (u.email ? u.email.trim().toLowerCase() : "") === normalizedEmail
      );
      if (hit) {
        existingUser = hit;
        break;
      }
      if (!pageData?.users || pageData.users.length < 1000) break; // 마지막 페이지
    }
    console.log("[Naver OAuth][step3.5] user lookup", {
      email: normalizedEmail,
      found: !!existingUser,
      userId: existingUser?.id?.slice(0, 8) ?? null,
    });

    let userId: string;

    if (existingUser) {
      // 기존 유저 — naver provider 정보 업데이트
      userId = existingUser.id;
      await supabaseAdmin.auth.admin.updateUserById(userId, {
        user_metadata: {
          ...existingUser.user_metadata,
          naver_id: naverId,
          full_name: existingUser.user_metadata?.full_name || name,
        },
      });
    } else {
      // 신규 유저 생성
      const { data: newUser, error: createError } =
        await supabaseAdmin.auth.admin.createUser({
          email,
          email_confirm: true,
          user_metadata: {
            naver_id: naverId,
            full_name: name,
            avatar_url: naverProfile.profile_image || "",
            provider: "naver",
          },
        });

      if (createError || !newUser.user) {
        console.error("[Naver OAuth] Create user error:", createError);
        return NextResponse.redirect(
          `${CANONICAL_ORIGIN}?login_error=create_user_error`
        );
      }
      userId = newUser.user.id;
    }

    // 4. 매직 링크 대신 OTP 없는 세션 생성
    //    admin.generateLink로 magiclink를 만들고 그 토큰으로 세션 생성
    const { data: linkData, error: linkError } =
      await supabaseAdmin.auth.admin.generateLink({
        type: "magiclink",
        email,
      });

    if (linkError || !linkData) {
      console.error("[Naver OAuth] Generate link error:", linkError);
      return NextResponse.redirect(
        `${CANONICAL_ORIGIN}?login_error=session_error`
      );
    }

    // linkData에서 token_hash와 hashed_token 추출
    const properties = linkData.properties;
    const tokenHash = properties?.hashed_token;

    if (!tokenHash) {
      console.error("[Naver OAuth] No hashed_token in link data:", linkData);
      return NextResponse.redirect(
        `${CANONICAL_ORIGIN}?login_error=token_error`
      );
    }

    // Supabase verify OTP로 세션 생성
    const supabaseServer = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            // cookieStore에도 설정 + pendingCookies에 수집
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
              pendingCookies.push({ name, value, options });
            });
          },
        },
      }
    );

    const { data: verifyData, error: verifyError } = await supabaseServer.auth.verifyOtp({
      type: "magiclink",
      token_hash: tokenHash,
    });

    if (verifyError) {
      console.error("[Naver OAuth][step4] Verify OTP error", {
        code: (verifyError as any)?.code,
        status: (verifyError as any)?.status,
        name: (verifyError as any)?.name,
        message: verifyError.message,
      });
      return NextResponse.redirect(
        `${CANONICAL_ORIGIN}?login_error=verify_error`
      );
    }
    console.log("[Naver OAuth][step4] verifyOtp ok", {
      hasSession: !!verifyData?.session,
      hasUser: !!verifyData?.user,
      pendingCookieCount: pendingCookies.length,
      pendingCookieNames: pendingCookies.map((c) => c.name),
    });

    // 신규 유저 또는 프로필 미완 유저는 /setup으로, 완료된 유저는 홈으로
    // (Google/Kakao auth/callback과 동일한 정책)
    let redirectPath = "";
    try {
      const { data: profile } = await supabaseAdmin
        .from("profiles")
        .select("id, nickname, team_id")
        .eq("id", userId)
        .maybeSingle();
      const needsSetup = !profile || !profile.nickname || !profile.team_id;
      redirectPath = needsSetup ? "/setup" : "";
    } catch (e) {
      console.error("[Naver OAuth] profile check failed:", e);
      // 체크 실패해도 홈으로 보냄 (안전한 기본값)
    }

    // Hash fallback — iOS Safari/PWA에서 서드파티 쿠키가 미작동하는 상황 대비
    // (/auth/callback과 동일 패턴 — 클라이언트가 setSession()으로 복구)
    const session = verifyData?.session;
    const hashParams = session
      ? `#access_token=${session.access_token}&refresh_token=${session.refresh_token}&type=recovery`
      : "";

    // state 쿠키 정리 + verifyOtp 쿠키를 response에 전달
    const redirectUrl = isNativeIOS && hashParams
      ? `${IOS_NATIVE_CALLBACK_ORIGIN}?next=${encodeURIComponent(redirectPath || "/")}${hashParams}`
      : `${CANONICAL_ORIGIN}${redirectPath}${hashParams}`;
    const response = NextResponse.redirect(redirectUrl);
    response.cookies.delete("naver_oauth_state");
    response.cookies.delete("naver_native_ios");
    // verifyOtp이 설정한 Supabase auth 쿠키를 redirect 응답에 복사
    // (path/sameSite/httpOnly 누락 방지 — Google/Kakao flow와 동일)
    for (const { name, value, options } of pendingCookies) {
      response.cookies.set(name, value, {
        ...options,
        path: (options?.path as string) || "/",
        sameSite: (options?.sameSite as "lax" | "strict" | "none") || "lax",
        httpOnly: (options?.httpOnly as boolean) ?? false,
        secure: process.env.NODE_ENV !== "development",
      });
    }

    console.log("[Naver OAuth] success", {
      userId: userId.slice(0, 8),
      email,
      needsSetup: redirectPath === "/setup",
      cookieCount: pendingCookies.length,
      hasHash: !!hashParams,
      isNativeIOS,
    });

    return response;
  } catch (err) {
    console.error("[Naver OAuth] Unexpected error:", err);
    return NextResponse.redirect(
      `${CANONICAL_ORIGIN}?login_error=unexpected`
    );
  }
}
