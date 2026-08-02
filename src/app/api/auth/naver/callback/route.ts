import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { lookupAuthUserByEmail } from "@/lib/supabase/naver-user-lookup";

// ⚠️ 2026-04-21 state 쿠키 도메인 불일치 수정 (fryfish P0)
// start route와 callback route가 동일 호스트를 사용해야 쿠키 공유 가능.
// 들어온 요청의 origin(www 혹은 apex)을 그대로 사용 → start와 callback이 항상 일치.
function getOrigin(request: NextRequest) {
  return request.nextUrl.origin;
}

/**
 * naver provider identity를 auth.identities에 upsert.
 *
 * Supabase는 네이버를 공식 OAuth provider로 지원하지 않아서
 * auth.admin 공식 API로 identity 링크 불가 → service_role에게 허용된
 * auth schema 직접 접근이 필요. 다른 OAuth provider들(kakao/google)이
 * 자동 생성하는 identity row와 동일한 스키마로 생성한다.
 *
 * on_conflict(provider, provider_id): 이미 존재하면 identity_data/updated_at만 갱신.
 */
async function upsertNaverIdentity(
  supabaseAdmin: any,
  opts: { userId: string; naverId: string; email: string; name: string; avatarUrl: string }
) {
  const { userId, naverId, email, name, avatarUrl } = opts;
  const now = new Date().toISOString();
  const identity_data = {
    sub: naverId,
    iss: "https://nid.naver.com",
    email,
    email_verified: true,
    phone_verified: false,
    full_name: name,
    name,
    provider_id: naverId,
    avatar_url: avatarUrl,
  };

  // Supabase PostgREST는 기본적으로 public 스키마만 노출함.
  // auth 스키마 접근은 raw SQL이 필요 → service_role에 허용된 rpc 함수 경유.
  // 프로젝트에 `upsert_naver_identity(uuid, text, jsonb)` rpc가 존재한다고 가정 → 없으면 미리 생성 필요.
  const { data, error } = await (supabaseAdmin as any).rpc("upsert_naver_identity", {
    p_user_id: userId,
    p_provider_id: naverId,
    p_identity_data: identity_data,
    p_created_at: now,
  });
  if (error) {
    // rpc 미존재하면 에러 날림 → 너기는 상위에서 캐치해 로그 남김
    throw new Error(`upsert_naver_identity rpc failed: ${error.message}`);
  }
  return data;
}

const NATIVE_CALLBACK_ORIGIN = "fan.keubo.app://auth/callback";

type NaverLookupClient = Parameters<typeof lookupAuthUserByEmail>[0];
type NaverAdminClient = NaverLookupClient & {
  auth: NaverLookupClient["auth"] & {
    admin: NaverLookupClient["auth"]["admin"] & {
      updateUserById(
        userId: string,
        attributes: { user_metadata: Record<string, unknown> }
      ): PromiseLike<unknown>;
      createUser(attributes: {
        email: string;
        email_confirm: boolean;
        user_metadata: Record<string, unknown>;
      }): PromiseLike<{
        data: { user: { id: string } | null };
        error: { message: string } | null;
      }>;
    };
  };
};

type NaverUserResolution =
  | { ok: true; userId: string; existing: boolean }
  | { ok: false; errorCode: "user_lookup_error" | "create_user_error" };

/**
 * 네이버 callback의 기존 사용자 조회와 신규 생성 분기를 한 seam으로 실행한다.
 * 조회가 불확실하면 신규 생성을 시도하지 않고 fail-close한다.
 */
export async function resolveNaverUserForCallback(
  supabaseAdmin: NaverAdminClient,
  profile: {
    email: string;
    naverId: string;
    name: string;
    avatarUrl: string;
  }
): Promise<NaverUserResolution> {
  const normalizedEmail = profile.email.trim().toLowerCase();
  let existingUser;
  try {
    existingUser = await lookupAuthUserByEmail(supabaseAdmin, normalizedEmail);
  } catch (lookupError) {
    console.error("[Naver OAuth] indexed user lookup error:", {
      message: (lookupError as Error).message,
    });
    return { ok: false, errorCode: "user_lookup_error" };
  }

  if (existingUser) {
    await supabaseAdmin.auth.admin.updateUserById(existingUser.id, {
      user_metadata: {
        ...existingUser.user_metadata,
        naver_id: profile.naverId,
        full_name: existingUser.user_metadata?.full_name || profile.name,
      },
    });
    return { ok: true, userId: existingUser.id, existing: true };
  }

  const { data: newUser, error: createError } =
    await supabaseAdmin.auth.admin.createUser({
      email: profile.email,
      email_confirm: true,
      user_metadata: {
        naver_id: profile.naverId,
        full_name: profile.name,
        avatar_url: profile.avatarUrl,
        provider: "naver",
      },
    });

  if (createError || !newUser.user) {
    console.error("[Naver OAuth] Create user error:", createError);
    return { ok: false, errorCode: "create_user_error" };
  }
  return { ok: true, userId: newUser.user.id, existing: false };
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
  // 실패 응답에도 stale native 쿠키를 정리 — native 로그인 취소/에러로 성공 경로의
  //   삭제까지 못 갔을 때 다음 web 로그인이 native로 오인되는 것 방지(삼순 리뷰 #449).
  const failRedirect = (target: string) => {
    const res = NextResponse.redirect(target);
    res.cookies.delete("naver_native");
    return res;
  };
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
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
    return failRedirect(
      `${CANONICAL_ORIGIN}?login_error=${encodeURIComponent(error)}`
    );
  }

  if (!code) {
    return failRedirect(
      `${CANONICAL_ORIGIN}?login_error=no_code`
    );
  }

  // CSRF state 검증
  const cookieStore = await cookies();
  // native 플랫폼 판별 — redirect_uri query 대신 start route가 심은 쿠키로 판별.
  //   (네이버 등록 Callback URL과 redirect_uri를 정확히 일치시키기 위해 query를 제거함)
  const nativePlatform = cookieStore.get("naver_native")?.value;
  const isNativeIOS = nativePlatform === "ios";
  const isNativeAndroid = nativePlatform === "android";
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
    return failRedirect(
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

    // 이메일 인덱스로 기존 유저 단건 조회.
    // listUsers() 페이지 순회는 총 유저가 20,000명을 넘으면 오래된 유저를 누락해
    // 중복 createUser() → create_user_error를 만들었으므로 사용하지 않는다.
    const userResolution = await resolveNaverUserForCallback(
      supabaseAdmin as unknown as NaverAdminClient,
      {
        email,
        naverId: String(naverId),
        name,
        avatarUrl: naverProfile.profile_image || "",
      }
    );
    if (!userResolution.ok) {
      return NextResponse.redirect(
        `${CANONICAL_ORIGIN}?login_error=${userResolution.errorCode}`
      );
    }
    console.log("[Naver OAuth][step3.5] user lookup", {
      email: String(email).trim().toLowerCase(),
      found: userResolution.existing,
      userId: userResolution.userId.slice(0, 8),
    });
    const userId = userResolution.userId;

    // 3.5 naver provider identity upsert (Supabase 공식 OAuth 미지원 → 수동 insert)
    //     이 단계가 없으면 auth.identities에 email provider만 남아서
    //     향후 연동/세션 복원 등에서 네이버 provider 식별 불가 (2026-04-21 fryfish 사례)
    try {
      await upsertNaverIdentity(supabaseAdmin, {
        userId,
        naverId: String(naverId),
        email,
        name,
        avatarUrl: naverProfile.profile_image || "",
      });
      console.log("[Naver OAuth][step3.5] identity linked", { userId: userId.slice(0, 8) });
    } catch (linkErr) {
      // identity 링크 실패해도 로그인 자체는 진행 (기존 동작 유지)
      console.error("[Naver OAuth][step3.5] identity link failed", {
        userId: userId.slice(0, 8),
        message: (linkErr as any)?.message,
      });
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
    //  - iOS·Android 네이티브: custom scheme(fan.keubo.app://)으로 세션 토큰 전달.
    //    (Android도 커스텀 스킴을 쓴다 — https /auth/callback로 되받으면 기기 App Link
    //     미검증 시 콜백이 Chrome에서 처리돼 세션이 앱이 아닌 Chrome에만 남는다
    //     = "크롬만 로그인 / 앱 로그아웃"(#cs 2026-07-09). 커스텀 스킴은 검증에 의존하지 않아
    //     appUrlOpen이 항상 가로채 setSession. 중간 /api/auth/naver/callback은
    //     App Link/딥링크 비대상이라 서버에서 처리됨.)
    //  - web: 서버 쿠키로 세션 유지
    let redirectUrl: string;
    if ((isNativeIOS || isNativeAndroid) && hashParams) {
      redirectUrl = `${NATIVE_CALLBACK_ORIGIN}?next=${encodeURIComponent(redirectPath || "/")}${hashParams}`;
    } else {
      redirectUrl = `${CANONICAL_ORIGIN}${redirectPath}${hashParams}`;
    }
    const response = NextResponse.redirect(redirectUrl);
    response.cookies.delete("naver_oauth_state");
    response.cookies.delete("naver_native");
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
    return failRedirect(
      `${CANONICAL_ORIGIN}?login_error=unexpected`
    );
  }
}
