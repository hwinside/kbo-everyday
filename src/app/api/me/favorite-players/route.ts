import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { verifyAccessToken } from "@/lib/auth/verified-user";
import { getTeamById } from "@/lib/constants/teams";
import { parseFavorites, type FavoritePayload } from "@/lib/profile/favorite-players-validation";

/**
 * PUT /api/me/favorite-players — 최애선수(+옵션 팀) 저장.
 *
 * 2026-08-24 최애선수 설정 유실 수정(#cs 제보):
 * 기존엔 클라이언트가 anon 키로 profiles를 직접 update하고 오류를 확인하지
 * 않아, 저장 실패 시 새 값이 로컬에만 잠깐 보이다 DB 옛 값으로 롤백됐다.
 * 이 라우트는 ①verified user만 ②payload 검증(최대 5명·중복 제거) ③본인
 * 1행 exact update(.single()) ④저장된 row를 그대로 반환 — 클라이언트는
 * 이 반환 row로만 로컬 상태를 확정한다.
 */

// 검증 로직은 favorite-players-validation.ts(순수 모듈)가 SSOT — 라우트와
// qa:favorites-save 회귀가 같은 함수를 import해 production seam 불일치를 차단.

export async function PUT(request: NextRequest) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "missing_config" }, { status: 500 });
  }

  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  if (!token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const user = await verifyAccessToken(token);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    // 이중 방어(삼순 5차 리뷰): 클라이언트가 기대한 사용자와 토큰 사용자가 다르면
    // 저장 전에 거절 — 계정 전환 경합에서 엉뚱한 계정 DB가 갱신되는 side effect 차단.
    // 헤더 미전송(구 클라이언트/타 호출자)은 기존 동작 유지.
    const expectedUser = request.headers.get("x-expected-user-id");
    if (expectedUser && expectedUser !== user.id) {
      return NextResponse.json({ error: "user_mismatch" }, { status: 409 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }

    const favorites = parseFavorites(body.favorite_players);
    if (favorites === null) {
      return NextResponse.json({ error: "invalid_favorites" }, { status: 400 });
    }

    const updates: {
      favorite_players: FavoritePayload[];
      team_id?: number;
      updated_at: string;
    } = {
      favorite_players: favorites,
      updated_at: new Date().toISOString(),
    };

    if (body.team_id !== undefined) {
      if (typeof body.team_id !== "number" || !getTeamById(body.team_id)) {
        return NextResponse.json({ error: "invalid_team" }, { status: 400 });
      }
      updates.team_id = body.team_id;
    }

    const admin = getSupabaseAdmin();
    // 본인 1행 exact update — .single()은 0행(프로필 없음)·다행 모두 오류로 만든다.
    const { data: profile, error } = await admin
      .from("profiles")
      .update(updates)
      .eq("id", user.id)
      .select()
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return NextResponse.json({ error: "profile_not_found" }, { status: 404 });
      }
      console.error("[api/me/favorite-players] update error:", error);
      return NextResponse.json({ error: "save_failed" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, profile });
  } catch (e) {
    console.error("[api/me/favorite-players] server error:", e);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
