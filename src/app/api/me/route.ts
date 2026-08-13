import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { verifyAccessToken } from "@/lib/auth/verified-user";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    return NextResponse.json({ profile: null, error: "missing_config" }, { status: 500 });
  }

  // Bearer 토큰으로 유저 검증 (쿠키 의존 X)
  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.replace("Bearer ", "");

  if (!token) {
    return NextResponse.json({ profile: null }, { status: 401 });
  }

  try {
    const adminClient = getSupabaseAdmin();

    // 토큰으로 유저 검증 (로컬 exp 프리체크 + dead-token 캐시로 무효 토큰의 Supabase 호출 차단)
    const user = await verifyAccessToken(token);
    if (!user) {
      return NextResponse.json({ profile: null }, { status: 401 });
    }

    // 검증된 유저의 프로필만 조회 (service role → RLS 우회)
    const { data: profile } = await adminClient
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .maybeSingle();

    return NextResponse.json({ profile });
  } catch (e) {
    return NextResponse.json({ profile: null, error: "server_error" }, { status: 500 });
  }
}
