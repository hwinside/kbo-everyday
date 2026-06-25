import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

/**
 * 네이버 로그인 — 수동 OAuth flow (Supabase Custom OIDC 우회)
 * GoTrue가 openid scope를 강제 추가하는 문제 해결
 *
 * GET /api/auth/naver → 네이버 OAuth authorize로 redirect
 */
export async function GET(request: NextRequest) {
  const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
  const userAgent = request.headers.get("user-agent") || "";
  const referer = request.headers.get("referer") || "";
  // Structured diag log for mobile login triage (2026-04-21)
  console.log("[Naver OAuth][start] authorize init", {
    isMobile: /Mobi|Android|iPhone|iPad/i.test(userAgent),
    isInApp: /Instagram|KAKAOTALK|FBAN|FBAV|Line|NAVER\(inapp/i.test(userAgent),
    uaShort: userAgent.slice(0, 120),
    referer: referer.slice(0, 80),
  });
  if (!NAVER_CLIENT_ID) {
    return NextResponse.json(
      { error: "NAVER_CLIENT_ID not configured" },
      { status: 500 }
    );
  }

  // ⚠️ 2026-04-21 fryfish 모바일 로그인 실패 원인 확정 — state 쿠키 도메인 불일치
  //
  // 문제: 기존 코드는 prod에서 `NEXT_PUBLIC_SITE_URL` (apex `keubo.fan`)로 redirect_uri 강제 →
  //       사용자가 `www.keubo.fan`으로 접속하면 state 쿠키는 www에 설정되는데
  //       네이버 callback은 apex `keubo.fan`으로 돌아와서 쿠키 없음 → state mismatch → 로그인 실패.
  // 해법: 들어온 요청의 origin(host)을 그대로 redirect_uri에 사용.
  //       www 진입 → www로 callback / apex 진입 → apex로 callback.
  //       state 쿠키와 callback 도메인이 항상 일치하므로 subdomain boundary에서 쿠키 탈락 없음.
  //
  // 주의: callback route의 `getOrigin()`도 동일하게 `request.nextUrl.origin` 우선 정책으로 변경함.
  //       로그인 후 redirect하는 홈 경로도 진입 호스트 그대로 유지 → www 유저는 www에서 로그인 유지.
  const CANONICAL_ORIGIN = request.nextUrl.origin;
  const nativeParam = request.nextUrl.searchParams.get("native");
  const isNative = nativeParam === "ios" || nativeParam === "android";

  // state 파라미터: CSRF 방지
  const state = crypto.randomUUID();

  // 네이버 OAuth authorize URL — scope 파라미터 생략 (앱 기본 권한 사용)
  const naverAuthUrl = new URL("https://nid.naver.com/oauth2.0/authorize");
  naverAuthUrl.searchParams.set("response_type", "code");
  naverAuthUrl.searchParams.set("client_id", NAVER_CLIENT_ID);
  // ⚠️ redirect_uri는 query 없이 고정 — 네이버에 등록된 Callback URL과 정확히 일치해야 함.
  //   (2026-06-25 iOS callback hit 0건 사고: `?native=ios` query가 등록값과 불일치해
  //    동의 후 네이버가 우리 callback으로 redirect 안 함.) native 여부는 아래 쿠키로 전달한다.
  const redirectUri = `${CANONICAL_ORIGIN}/api/auth/naver/callback`;
  naverAuthUrl.searchParams.set("redirect_uri", redirectUri);
  naverAuthUrl.searchParams.set("state", state);

  const response = NextResponse.redirect(naverAuthUrl.toString());

  // native 플랫폼은 쿠키로 callback에 전달 (redirect_uri query 대체).
  //   callback이 ios/android 여부에 따라 앱으로 세션을 돌려줄 redirect 형태를 결정.
  // ⚠️ 매 시작마다 먼저 삭제 후 native일 때만 set — 직전 native 로그인이 취소/에러로
  //   callback의 삭제까지 못 간 경우, 10분 내 web 네이버 로그인이 stale 쿠키로 native로
  //   오인되는 것 방지(삼순 리뷰 #449).
  response.cookies.delete("naver_native");
  if (isNative) {
    response.cookies.set("naver_native", nativeParam!, {
      httpOnly: true,
      secure: process.env.NODE_ENV !== "development",
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });
  }

  response.cookies.set("naver_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development",
    sameSite: "lax",
    maxAge: 600, // 10분
    path: "/",
  });

  return response;
}
