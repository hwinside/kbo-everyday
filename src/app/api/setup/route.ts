import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { verifyAccessToken } from "@/lib/auth/verified-user";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { nickname, team_id, invite_code, favorite_players } = body;

    if (!nickname || !team_id) {
      return NextResponse.json({ error: "닉네임과 팀을 선택해주세요" }, { status: 400 });
    }

    // 1. 세션에서 유저 확인 (쿠키 또는 Authorization 헤더)
    let userId: string | null = null;

    // Authorization 헤더로 먼저 시도
    const authHeader = request.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const user = await verifyAccessToken(token);
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

    // 2. 서버측 닉네임 중복 조회 (현재 DB에 nickname UNIQUE constraint 없음 — 애플리케이션 레벨에서 강제)
    // 단, race condition 완전 차단은 도 떨어질 수 있으니 (동시 두 사람이 같은 닉으로 POST 가능)
    // 후속 마이그레이션으로 UNIQUE 추가 예정. 그때까지는 상필 수준 차단.
    const trimmedNickname = nickname.trim();
    // 2026-04-19: case-insensitive 비교 (ktwiz/Ktwiz 중복 실사례)
    const { data: dupCheck, error: dupError } = await admin
      .from("profiles")
      .select("id")
      .ilike("nickname", trimmedNickname)
      .limit(1)
      .maybeSingle();

    if (dupError) {
      console.error("[api/setup] dup check error:", dupError);
      return NextResponse.json({ error: "닉네임 확인 중 오류가 발생했습니다" }, { status: 500 });
    }
    if (dupCheck) {
      return NextResponse.json({ error: "이미 사용 중인 닉네임입니다" }, { status: 409 });
    }

    // 3. 최애선수 검증 (localStorage에서 전달된 값, 최대 5명)
    const validatedPlayers = Array.isArray(favorite_players)
      ? favorite_players
          .filter(
            (p: Record<string, unknown>) =>
              typeof p.playerId === "string" &&
              typeof p.name === "string" &&
              typeof p.teamId === "number" &&
              typeof p.position === "string" &&
              typeof p.number === "number"
          )
          .slice(0, 5)
          .map((p: Record<string, unknown>) => ({
            playerId: String(p.playerId),
            name: String(p.name),
            teamId: Number(p.teamId),
            position: String(p.position),
            number: Number(p.number),
          }))
      : [];

    // 4. 프로필 생성
    const { error: insertError } = await admin.from("profiles").insert({
      id: userId,
      nickname: trimmedNickname,
      team_id,
      favorite_players: validatedPlayers,
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

    // 5. 초대코드 처리 (선택)
    if (invite_code) {
      const normalizedCode = invite_code.trim().toUpperCase().replace(/^KBO-/i, "KEUBO-");
      const { data: invite, error: inviteFindError } = await admin
        .from("invitations")
        .select("id, inviter_id, used_at")
        .eq("code", normalizedCode)
        .maybeSingle();

      if (inviteFindError) {
        console.error("[api/setup] invite find error:", inviteFindError);
        await admin.from("profiles").delete().eq("id", userId);
        return NextResponse.json({ error: "초대코드 확인 중 오류가 발생했습니다" }, { status: 500 });
      }
      if (!invite) {
        // 초대코드 무효 — 프로필은 이미 생성됐으니 경고만
        return NextResponse.json({ ok: true, warning: "초대코드가 유효하지 않습니다" });
      }
      if (invite.used_at) {
        return NextResponse.json({ ok: true, warning: "이미 사용된 초대코드입니다" });
      }
      if (invite.inviter_id === userId) {
        await admin.from("profiles").delete().eq("id", userId);
        return NextResponse.json({ error: "본인의 초대코드는 사용할 수 없습니다" }, { status: 403 });
      }

      const usedAt = new Date().toISOString();

      // 초대코드 사용 처리 — /api/invite/use와 동일하게 invitee_id + invited_by를 연결해야 함
      const { error: inviteUpdateError } = await admin.from("invitations").update({
        invitee_id: userId,
        used_at: usedAt,
      }).eq("id", invite.id);

      if (inviteUpdateError) {
        console.error("[api/setup] invite update error:", inviteUpdateError);
        await admin.from("profiles").delete().eq("id", userId);
        return NextResponse.json({ error: "초대코드 등록에 실패했습니다" }, { status: 500 });
      }

      const { error: profileInviteError } = await admin
        .from("profiles")
        .update({
          invited_by: invite.inviter_id,
          is_founder: true,
        })
        .eq("id", userId);

      if (profileInviteError) {
        console.error("[api/setup] profile invite update error:", profileInviteError);
        await admin.from("invitations").update({ invitee_id: null, used_at: null }).eq("id", invite.id);
        await admin.from("profiles").delete().eq("id", userId);
        return NextResponse.json({ error: "초대코드 등록에 실패했습니다" }, { status: 500 });
      }

      await admin
        .from("user_badges")
        .upsert({ user_id: userId, badge_id: "founder" }, { onConflict: "user_id,badge_id" });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[api/setup] unexpected error:", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
