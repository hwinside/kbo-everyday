import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server";

/**
 * 워치(갤워치 Wear OS + 애플워치) 앱 사용 계측 (2026-07-19 하린아빠 요청).
 *
 * 두 워치 앱은 매 동기화마다 고유 UA로 /api/standings를 호출한다:
 *   Wear OS      = kbo-everyday-wear/1.0   → platform 'wear'
 *   Apple Watch  = kbo-everyday-watch/1.0  → platform 'apple'
 * /api/standings는 CDN 캐시(s-maxage=300)라 라우트 핸들러는 캐시 미스에만 실행되므로,
 * 캐시 앞단에서 매 요청 실행되는 미들웨어에서 계측해야 워치 요청을 전량 잡는다.
 *
 * 절대 요청을 막거나 지연시키지 않는다: 워치 UA가 아니면 즉시 통과(오버헤드 = UA 문자열 검사),
 * 워치 UA면 fire-and-forget(waitUntil)로 record_watch_ping RPC만 쏘고 응답은 그대로 통과.
 */
export function middleware(req: NextRequest, event: NextFetchEvent): NextResponse {
  const ua = req.headers.get("user-agent") || "";
  // "kbo-everyday-wear" vs "kbo-everyday-watch" — 서로 substring 아님(wear/watch), 안전하게 구분.
  const platform = ua.includes("kbo-everyday-wear")
    ? "wear"
    : ua.includes("kbo-everyday-watch")
      ? "apple"
      : null;

  if (platform) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (url && key) {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
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
  }
  return NextResponse.next();
}

// 두 워치 앱이 매 동기화마다 정확히 1번 치는 /api/standings 만 매칭(중복 카운트 방지 + 실행 최소화).
export const config = {
  matcher: "/api/standings",
};
