import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  checkMoveReadiness,
  moveHref,
  publishedRegisterHref,
  filterVisibleMoves,
} from "@/lib/roster-moves/readiness";

// 팀별 최근 등록/말소 조회. 예: /api/roster-moves?teamId=6&days=30
// 노출 계약(2026-07-18 삼순 P0 반영):
// - 등록(register): published만 반환 — 준비(로스터+사진+히어로+상세페이지) 완료 전 미노출.
//   반환되는 등록 항목은 예외 없이 클릭 가능(href 항상 non-null).
// - 말소(deregister): 전부 반환 — readiness는 링크 유무만 결정(미준비 = 링크 생략).
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const teamId = Number(searchParams.get("teamId"));
  const days = Math.min(Math.max(Number(searchParams.get("days")) || 30, 1), 90);
  if (!teamId) {
    return NextResponse.json({ error: "teamId required" }, { status: 400 });
  }

  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("roster_moves")
    .select("kbo_player_id, player_name, move_type, move_date, status")
    .eq("team_id", teamId)
    .gte("move_date", sinceStr)
    .order("move_date", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const moves = filterVisibleMoves(
    (data ?? []).map((m) => ({ ...m, moveType: m.move_type as "register" | "deregister" })),
  ).map((m) => ({
    kboPlayerId: m.kbo_player_id,
    playerName: m.player_name,
    moveType: m.moveType,
    moveDate: m.move_date,
    // 등록(published만 도달): href 항상 보장. 말소: readiness 따라 링크 생략 가능.
    href:
      m.moveType === "register"
        ? publishedRegisterHref(m.kbo_player_id)
        : moveHref(checkMoveReadiness(m.kbo_player_id)),
  }));

  return NextResponse.json({ teamId, days, moves });
}
