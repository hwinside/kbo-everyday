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
