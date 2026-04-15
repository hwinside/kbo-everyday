import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

// prod에서는 canonical domain, 로컬에서는 request origin 사용
function getOrigin(request: NextRequest) {
  if (process.env.NODE_ENV === "development") {
    return request.nextUrl.origin;
  }
  return process.env.NEXT_PUBLIC_SITE_URL || "https://keubo.fan";
}

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
    console.error("[Naver OAuth] State mismatch:", { savedState, state });
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
    const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find(
      (u) => u.email === email
    );

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

    const { error: verifyError } = await supabaseServer.auth.verifyOtp({
      type: "magiclink",
      token_hash: tokenHash,
    });

    if (verifyError) {
      console.error("[Naver OAuth] Verify OTP error:", verifyError);
      return NextResponse.redirect(
        `${CANONICAL_ORIGIN}?login_error=verify_error`
      );
    }

    // state 쿠키 정리 + verifyOtp 쿠키를 response에 전달
    const response = NextResponse.redirect(CANONICAL_ORIGIN);
    response.cookies.delete("naver_oauth_state");
    // verifyOtp이 설정한 Supabase auth 쿠키를 redirect 응답에 복사
    for (const { name, value, options } of pendingCookies) {
      response.cookies.set(name, value, {
        ...options,
        secure: process.env.NODE_ENV !== "development",
      });
    }
    return response;
  } catch (err) {
    console.error("[Naver OAuth] Unexpected error:", err);
    return NextResponse.redirect(
      `${CANONICAL_ORIGIN}?login_error=unexpected`
    );
  }
}
