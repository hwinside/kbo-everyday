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

  // Public users do not have a session to refresh. Authenticated prefetches keep
  // the local claims check so an expiring session can still rotate its cookies.
  if (!hasAuthCookie) {
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

  // ES256 JWT는 JWKS로 로컬 검증한다. 만료 임박 세션 갱신은 getSession 경로에서 유지되며,
  // 매 페이지/RSC 요청마다 /auth/v1/user를 호출하는 증폭은 제거한다.
  await supabase.auth.getClaims();

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
