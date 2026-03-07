import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const CANONICAL_HOST = "keubo.fan";

export async function proxy(request: NextRequest) {
  // Force canonical domain: *.vercel.app → keubo.fan (prevents PWA breakage)
  const host = request.headers.get("host") || "";
  if (
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

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
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

  // 세션 갱신 (중요!)
  await supabase.auth.getUser();

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
