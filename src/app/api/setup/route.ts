import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { nickname, team_id, invite_code } = body;

    if (!nickname || !team_id) {
      return NextResponse.json({ error: "닉네임과 팀을 선택해주세요" }, { status: 400 });
    }

    // 1. 세션에서 유저 확인 (쿠키 또는 Authorization 헤더)
    let userId: string | null = null;

    // Authorization 헤더로 먼저 시도
    const authHeader = request.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const admin = getSupabaseAdmin();
      const { data: { user } } = await admin.auth.getUser(token);
      userId = user?.id ?? null;
    }

    // 쿠키로 fallback
    if (!userId) {
      const cookieStore = await cookies();
      const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
          cookies: {
            getAll() { return cookieStore.getAll(); },
            setAll() { /* read-only */ },
          },
        }
      );
      const { data: { user } } = await supabase.auth.getUser();
      userId = user?.id ?? null;
    }

    if (!userId) {
      return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
    }

    const admin = getSupabaseAdmin();

    // 2. 프로필 생성
    const { error: insertError } = await admin.from("profiles").insert({
      id: userId,
      nickname: nickname.trim(),
      team_id,
      favorite_players: [],
      invited_by: null,
      is_founder: false,
      invite_count: 5,
      joined_at: new Date().toISOString(),
    });

    if (insertError) {
      if (insertError.code === "23505") {
        // unique constraint violation
        if (insertError.message.includes("nickname")) {
          return NextResponse.json({ error: "이미 사용 중인 닉네임입니다" }, { status: 409 });
        }
        // profile already exists
        return NextResponse.json({ error: "이미 프로필이 존재합니다" }, { status: 409 });
      }
      console.error("[api/setup] insert error:", insertError);
      return NextResponse.json({ error: "프로필 생성 실패" }, { status: 500 });
    }

    // 3. 초대코드 처리 (선택)
    if (invite_code) {
      const normalizedCode = invite_code.trim().toUpperCase();
      const { data: invite } = await admin
        .from("invitations")
        .select("id, used_at")
        .eq("code", normalizedCode)
        .maybeSingle();

      if (!invite) {
        // 초대코드 무효 — 프로필은 이미 생성됐으니 경고만
        return NextResponse.json({ ok: true, warning: "초대코드가 유효하지 않습니다" });
      }
      if (invite.used_at) {
        return NextResponse.json({ ok: true, warning: "이미 사용된 초대코드입니다" });
      }

      // 초대코드 사용 처리
      await admin.from("invitations").update({
        used_at: new Date().toISOString(),
        used_by: userId,
      }).eq("id", invite.id);
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[api/setup] unexpected error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
