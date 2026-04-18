/**
 * Design V2 Middleware (T1.3.2 + T1.3.5 Lockdown Guard)
 *
 * Spec: specs/design-v2-migration.md (v0.5) §3
 * Plan §3.2
 *
 * 기능:
 *   1. URL `?v2=1` → `kbo-design=v2` 쿠키 set + 파라미터 제거 리다이렉트
 *   2. URL `?v2=0` → 쿠키 delete + 파라미터 제거 리다이렉트
 *   3. `/v2/*` 접근 가드: 쿠키 없으면 루트로 redirect (lockdown 중엔 항상 차단)
 *   4. Lockdown: USER_EXPOSURE_LOCKDOWN = true 면 일반 유저 V2 노출 차단 (내부자 `?v2=1` 은 예외)
 */

import { NextRequest, NextResponse } from "next/server";
import {
  DESIGN_VERSION_COOKIE,
  DESIGN_VERSION_COOKIE_MAX_AGE,
  USER_EXPOSURE_LOCKDOWN,
} from "@/lib/feature-flags/design-version";

/** 내부자(수동 테스트) 우회용 별도 쿠키. `?v2=1` 이 세팅하는 것과 동일. */
const DESIGN_BYPASS_COOKIE = "kbo-design-bypass";

export function middleware(req: NextRequest) {
  const url = req.nextUrl;
  const pathname = url.pathname;

  // 1) ?v2=1 → 쿠키 설정 + 깨끗한 URL 로 리다이렉트
  const v2Param = url.searchParams.get("v2");
  if (v2Param === "1") {
    const cleanUrl = new URL(pathname, url);
    // 나머지 쿼리 유지
    for (const [k, v] of url.searchParams.entries()) {
      if (k !== "v2") cleanUrl.searchParams.set(k, v);
    }
    const res = NextResponse.redirect(cleanUrl);
    res.cookies.set(DESIGN_VERSION_COOKIE, "v2", {
      maxAge: DESIGN_VERSION_COOKIE_MAX_AGE,
      path: "/",
      sameSite: "lax",
    });
    // lockdown 바이패스 쿠키도 같이 세팅 (내부자 의도 명시)
    res.cookies.set(DESIGN_BYPASS_COOKIE, "1", {
      maxAge: DESIGN_VERSION_COOKIE_MAX_AGE,
      path: "/",
      sameSite: "lax",
    });
    return res;
  }

  if (v2Param === "0") {
    const cleanUrl = new URL(pathname, url);
    for (const [k, v] of url.searchParams.entries()) {
      if (k !== "v2") cleanUrl.searchParams.set(k, v);
    }
    const res = NextResponse.redirect(cleanUrl);
    res.cookies.delete(DESIGN_VERSION_COOKIE);
    res.cookies.delete(DESIGN_BYPASS_COOKIE);
    return res;
  }

  // 2) /v2/* 가드
  if (pathname.startsWith("/v2/") || pathname === "/v2") {
    const cookie = req.cookies.get(DESIGN_VERSION_COOKIE)?.value;
    const bypass = req.cookies.get(DESIGN_BYPASS_COOKIE)?.value === "1";

    // Lockdown 중엔 bypass 쿠키 없으면 차단
    if (USER_EXPOSURE_LOCKDOWN && !bypass) {
      return NextResponse.redirect(new URL("/", url));
    }

    // Lockdown 해제 후에도 v2 쿠키는 있어야 함
    if (cookie !== "v2") {
      return NextResponse.redirect(new URL("/", url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // 모든 app 경로 (api, _next, 정적 파일 제외)
    "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.png$|.*\\.jpg$|.*\\.svg$|.*\\.webp$|.*\\.ico$).*)",
  ],
};
