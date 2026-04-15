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
  if (!NAVER_CLIENT_ID) {
    return NextResponse.json(
      { error: "NAVER_CLIENT_ID not configured" },
      { status: 500 }
    );
  }

  // 로컬 개발 시 localhost를 사용하고, prod에서는 canonical domain 사용
  const requestOrigin = request.nextUrl.origin;
  const CANONICAL_ORIGIN =
    process.env.NODE_ENV === "development"
      ? requestOrigin
      : process.env.NEXT_PUBLIC_SITE_URL || "https://keubo.fan";

  // state 파라미터: CSRF 방지
  const state = crypto.randomUUID();

  // 네이버 OAuth authorize URL — scope 파라미터 생략 (앱 기본 권한 사용)
  const naverAuthUrl = new URL("https://nid.naver.com/oauth2.0/authorize");
  naverAuthUrl.searchParams.set("response_type", "code");
  naverAuthUrl.searchParams.set("client_id", NAVER_CLIENT_ID);
  naverAuthUrl.searchParams.set(
    "redirect_uri",
    `${CANONICAL_ORIGIN}/api/auth/naver/callback`
  );
  naverAuthUrl.searchParams.set("state", state);

  const response = NextResponse.redirect(naverAuthUrl.toString());

  // state를 쿠키에 저장 (callback에서 검증)
  response.cookies.set("naver_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development",
    sameSite: "lax",
    maxAge: 600, // 10분
    path: "/",
  });

  return response;
}
