import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET() {
  const cookieStore = await cookies();

  // 1. 쿠키 기반 클라이언트로 유저 인증 확인
  const authClient = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        },
      },
    }
  );

  const { data: { user } } = await authClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ profile: null });
  }

  // 2. Service role로 profile 조회 (RLS 우회 — 인증된 유저의 본인 프로필만)
  const adminClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: profile } = await adminClient
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  return NextResponse.json({ profile });
}
