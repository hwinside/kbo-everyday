import { createServerClient } from "@supabase/ssr";
import {
  NextResponse,
  type NextRequest,
  type NextFetchEvent,
} from "next/server";

const CANONICAL_HOST = "keubo.fan";

export function hasSupabaseAuthCookie(
  cookieNames: readonly string[],
  supabaseUrl: string | undefined,
): boolean {
  if (!supabaseUrl) return false;

  try {
    const projectRef = new URL(supabaseUrl).hostname.split(".")[0];
    if (!projectRef) return false;
    const cookiePrefix = `sb-${projectRef}-auth-token`;
    return cookieNames.some(
      (name) => name === cookiePrefix || name.startsWith(`${cookiePrefix}.`),
    );
  } catch {
    return false;
  }
}

/**
 * 서버측 세션 갱신은 오직 최상위 문서(top-level document) 네비게이션에서만 수행한다.
 *
 * 배경(2026-07-27, PR #890 리뷰):
 *  - 매 RSC/prefetch 요청마다 getClaims()로 세션을 갱신하면, 한 페이지가 유발하는 다수의
 *    동시 RSC/prefetch가 같은 refresh token을 두고 경합 → GoTrue refresh-token rate limit
 *    (403/429)을 유발한다. (24h 실측 4,728×403 + 679×429)
 *  - 그렇다고 서버 갱신을 전면 제거하면, access token 만료 + refresh token 유효 상태에서
 *    fresh navigation 시 서버 렌더가 익명으로 보이는 회귀가 생긴다.
 *  => 절충: 실제 문서 네비게이션(sec-fetch-dest: document)에서만 갱신해 서버 auth gate와
 *     cookie rotation을 유지하고, RSC/prefetch(빈 dest·RSC 헤더)는 건너뛰어 경합을 없앤다.
 */
export function isTopLevelDocumentNavigation(request: NextRequest): boolean {
  // Next.js RSC/prefetch 요청은 절대 서버 갱신을 트리거하면 안 된다(토큰 경합의 근원).
  if (request.headers.get("rsc")) return false;
  if (request.headers.get("next-router-prefetch")) return false;

  const dest = request.headers.get("sec-fetch-dest");
  // 실제 브라우저 문서 네비게이션만 'document'. RSC fetch 는 'empty'.
  if (dest) return dest === "document";

  // 헤더 부재(구형/일부 WebView)면 보수적으로 top-level 로 간주해 로그인 유지를 우선한다.
  return true;
}

/**
 * 워치(갤워치 Wear OS + 애플워치) 앱 사용 계측 (2026-07-19 하린아빠 요청).
 *
 * 두 워치 앱은 매 동기화마다 고유 UA로 /api/standings 를 정확히 1번 호출한다:
 *   kbo-everyday-wear/1.0   → 'wear'  (Wear OS)
 *   kbo-everyday-watch/1.0  → 'apple' (Apple Watch)
 * /api/standings 는 CDN 캐시(s-maxage=300)라 라우트 핸들러는 캐시 미스에만 실행되므로,
 * 캐시 앞단에서 매 요청 실행되는 proxy(구 middleware)에서 계측해야 워치 요청을 전량 잡는다.
 *
 * ⚠️ Next 16은 proxy.ts 와 middleware.ts 동시 존재를 금지(빌드 실패)하므로 별도 파일이 아니라
 * 기존 proxy 로 접어 넣는다. /api/standings 외에는 즉시 null(오버헤드 = UA 문자열 검사).
 */
export function classifyWatchPlatform(
  pathname: string,
  ua: string,
): "wear" | "apple" | null {
  if (pathname !== "/api/standings") return null;
  // "kbo-everyday-wear" vs "kbo-everyday-watch" — 서로 substring 아님(wear/watch), 안전하게 구분.
  if (ua.includes("kbo-everyday-wear")) return "wear";
  if (ua.includes("kbo-everyday-watch")) return "apple";
  return null;
}

// 워치 UA면 fire-and-forget(waitUntil)로 record_watch_ping RPC만 쏜다. 절대 응답을 막거나 지연시키지 않는다.
function recordWatchPing(
  event: NextFetchEvent,
  ip: string,
  platform: "wear" | "apple",
): void {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  event.waitUntil(
    fetch(`${url}/rest/v1/rpc/record_watch_ping`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ p_ip: ip, p_platform: platform }),
    }).catch(() => {
      // 계측 실패는 무해 — 서비스 응답에 영향 없음
    }),
  );
}

export async function proxy(request: NextRequest, event: NextFetchEvent) {
  const { pathname } = request.nextUrl;

  // Never canonical-redirect API routes. Vercel cron/functions may invoke
  // the deployment host directly, and redirecting those requests breaks job execution.
  if (pathname.startsWith("/api/")) {
    // 워치 UA 계측(fire-and-forget) — 응답 body/헤더/캐시(Cache-Control) 무변경, next() 그대로 통과.
    const platform = classifyWatchPlatform(
      pathname,
      request.headers.get("user-agent") || "",
    );
    if (platform) {
      const ip =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
      recordWatchPing(event, ip, platform);
    }
    return NextResponse.next({ request });
  }

  // Force canonical domain: *.vercel.app → keubo.fan (prevents PWA breakage)
  // BUT only in production. Preview deployments must stay on their vercel.app
  // host so QA (e.g. Vercel SSO login → redirect back to preview) works.
  // VERCEL_ENV is "production" | "preview" | "development" at build time.
  const host = request.headers.get("host") || "";
  const isProduction = process.env.VERCEL_ENV === "production";
  if (
    isProduction &&
    host !== CANONICAL_HOST &&
    host !== `www.${CANONICAL_HOST}` &&
    !host.startsWith("localhost") &&
    !host.startsWith("127.0.0.1")
  ) {
    const url = request.nextUrl.clone();
    url.host = CANONICAL_HOST;
    url.port = "";
    url.protocol = "https";
    return NextResponse.redirect(url, { status: 308 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const hasAuthCookie = hasSupabaseAuthCookie(
    request.cookies.getAll().map(({ name }) => name),
    supabaseUrl,
  );

  // Public users have no session to refresh.
  if (!hasAuthCookie) {
    return NextResponse.next({ request });
  }

  // Only real document navigations refresh the session. RSC/prefetch requests
  // skip it so concurrent prefetches never race the same refresh token (403/429).
  if (!isTopLevelDocumentNavigation(request)) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    supabaseUrl!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // ES256 JWT는 JWKS로 로컬 검증한다. 만료 임박 세션 갱신은 getClaims 경로에서 유지되며,
  // 매 RSC/prefetch 요청마다 갱신을 트리거하던 증폭은 top-level 게이트로 제거한다.
  await supabase.auth.getClaims();

  return supabaseResponse;
}

/**
 * matcher 슬림 (2026-08-20, Vercel 비용 3순위):
 *
 * /api/* 는 proxy 안에서 이미 순수 통과다 — canonical redirect 제외(의도적)·세션 갱신 없음·
 * 쿠키 무변경으로 `NextResponse.next()` 만 반환한다. 유일한 실제 일은 /api/standings 워치 UA
 * 계측(fire-and-forget)뿐이다. 그런데 matcher 가 catch-all 이라 폴링 API(counts 307K +
 * stats 225K + player-stats 198K ≈ 0.73M 회/일, 8/12 실측) 전부가 no-op middleware 를 1회씩
 * 태우고 있었다. → /api 는 matcher 에서 제외하되, 워치 계측이 있는 /api/standings 만 예외로
 * 유지한다(계측은 CDN 캐시 앞단인 proxy 에서만 전량을 잡는다 — 상단 주석 참조).
 *
 * 문서/페이지 경로는 그대로 매칭되어 canonical redirect(308)와 top-level 세션 갱신(#890)을
 * 보존한다. 함수 본문의 `pathname.startsWith("/api/")` 패스스루는 방어적으로 유지한다
 * (matcher 가 넘겨도 행동 동일 — 계약은 qa:proxy-matcher-slim 이 고정).
 */
export const config = {
  matcher: [
    "/((?!api/(?!standings(?:/|$))|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
