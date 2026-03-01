import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const origin = requestUrl.origin;

  if (code) {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
    
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    
    if (data?.session) {
      // 세션 토큰을 hash fragment로 전달 → 클라이언트에서 pickup
      const { access_token, refresh_token } = data.session;
      return NextResponse.redirect(
        `${origin}#access_token=${access_token}&refresh_token=${refresh_token}&type=recovery`
      );
    }
  }

  return NextResponse.redirect(origin);
}
